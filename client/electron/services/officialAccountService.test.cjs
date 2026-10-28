const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createConfigStore } = require('./configStore.cjs');
const { createOfficialAccountService } = require('./officialAccountService.cjs');
const { SERVICE_BASE_URL, AI_BASE_URL } = require('./officialApi.cjs');

const OPEN = '/qhp-yibiao/anonymous/yibiao/open';
const RECHARGE = '/qhp-yibiao/anonymous/yibiao/recharge';
const TEAM = '/qhp-yibiao/yibiao';
const anonymousToken = () => `yb1.${Buffer.from(`1:12:34:1:1:${Math.floor(Date.now() / 1000)}`).toString('base64url')}.test`;
const emailToken = () => `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.test`;
const account = { accountId: 34, subjectType: 'OPEN_ACCOUNT', subjectId: 34, availablePoint: 1000, netRechargePoint: 1000, totalConsumePoint: 0, sources: [] };
const order = { id: '100', orderNo: 'R-test', status: 'WAITING', refundStatus: 'NONE', payAmountFen: '101', rechargePoint: '1010', sourceSubjectType: 'OPEN_ACCOUNT', sourceSubjectId: '34', settledSubjectType: null, settledSubjectId: null };

function fixture(t, routes = {}) {
  const parent = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, '易标-V4-单元-'));
  const app = { getPath: () => directory };
  fs.writeFileSync(path.join(directory, 'user_config.json'), JSON.stringify({
    analytics_client_id: 'existing-client-id', analytics_created_at: '2026-01-01',
    text_model_provider: 'official', api_key: 'old-v3-key',
  }), 'utf-8');
  const configStore = createConfigStore(app);
  const calls = [];
  const defaults = {
    [`POST ${OPEN}/clients/login`]: () => anonymousToken(),
    [`GET ${OPEN}/account`]: () => account,
    [`GET ${OPEN}/api-keys`]: () => [{ name: '易标开源版', status: 'ACTIVE', keyValue: 'anonymous-v4-key' }],
    [`GET ${RECHARGE}/orders`]: () => [],
    [`GET ${TEAM}/team/mine`]: () => [{ tenantId: 90, name: '测试团队', isAdmin: true }],
    [`GET ${TEAM}/api-keys/available`]: () => [{ id: '90', name: '易标开源版', keyValue: 'team-v4-key', expireTime: null }],
  };
  const service = createOfficialAccountService({ app, configStore, powerMonitor: new EventEmitter(), fetchImpl: async (url, init) => {
    assert.ok(url.startsWith(`${SERVICE_BASE_URL}/`));
    const call = { url: new URL(url), ...init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const key = `${init.method} ${call.url.pathname}`;
    const handler = routes[key] || defaults[key];
    assert.ok(handler, `未预期请求：${key}`);
    const value = await handler(call);
    return value instanceof Response ? value : Response.json({ code: 0, data: value });
  } });
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, service, configStore, calls, routes };
}

test('切 V4 保留 Client ID 和旧文件，Long 编号及点数不损失精度', async (t) => {
  const f = fixture(t, {
    [`GET ${OPEN}/account`]: () => new Response('{"code":0,"data":{"accountId":9007199254740993,"subjectId":9007199254740993,"availablePoint":9007199254740995,"netRechargePoint":1000,"totalConsumePoint":0,"sources":[]}}'),
  });
  const oldFile = path.join(f.directory, 'official_api_session.json');
  fs.writeFileSync(oldFile, '旧会话原样保留', 'utf-8');
  await f.service.start();
  assert.equal(f.service.getState().accountId, '9007199254740993');
  assert.equal(f.service.getState().availablePoint, '9007199254740995');
  assert.equal(f.calls[0].body.clientId, 'existing-client-id');
  assert.equal(fs.readFileSync(oldFile, 'utf-8'), '旧会话原样保留');
  assert.ok(fs.existsSync(path.join(f.directory, 'official_api_session_v4.json')));
  assert.equal(f.configStore.load().api_key, 'anonymous-v4-key');
  assert.equal(f.configStore.load().base_url, AI_BASE_URL);
});

test('邮箱直接 JWT 响应、无个人账户 ID 和团队 Key；文本图片共用凭据', async (t) => {
  let bound = false;
  const f = fixture(t, {
    [`POST ${OPEN}/email/bind`]: (call) => { assert.ok(call.headers['X-Yibiao-Open-Token']); bound = true; return { token: emailToken() }; },
    [`GET ${OPEN}/account`]: (call) => {
      if (!bound) return account;
      assert.ok(call.headers.Authorization.startsWith('Bearer '));
      assert.equal(call.headers['X-Yibiao-Open-Token'], undefined);
      return { ...account, accountId: null, subjectType: 'TENANT', subjectId: 90, sources: [{ sourceAccountId: 34 }] };
    },
  });
  await f.service.start();
  const state = await f.service.bindEmail({ email: 'test@example.com', code: '123456' });
  assert.equal(state.accountId, null);
  assert.equal(state.subjectId, '90');
  assert.equal(state.teamName, '测试团队');
  assert.equal(state.isTeamAdmin, true);
  assert.deepEqual(state.sources, [{ sourceAccountId: '34' }]);
  f.configStore.save({ text_model_provider: 'custom', api_key: 'own-key', base_url: 'https://own.example/v1', image_model: { provider: 'official', api_key: 'stale-key' } });
  const config = f.configStore.load();
  assert.equal(config.api_key, 'own-key');
  assert.equal(config.image_model.api_key, 'team-v4-key');
  assert.equal(config.image_model.model_name, 'IMAGE_GENERATION');
  assert.equal(config.image_model.base_url, AI_BASE_URL);
  assert.equal(config.analytics_client_id, 'existing-client-id');
});

test('商品分转元、创建订单包装、二维码缓存和主动查单均使用 V4 合同', async (t) => {
  let paid = false;
  const f = fixture(t, {
    [`GET ${RECHARGE}/products`]: () => [{ id: 1, name: '商品', payAmountFen: '101', rechargePoint: '1010' }],
    [`POST ${RECHARGE}/orders`]: (call) => { assert.deepEqual(call.body, { productId: '1' }); return { order, codeUrl: 'weixin://test', qrCode: 'data:image/png;base64,dGVzdA==', prepayStatus: 'READY' }; },
    [`GET ${RECHARGE}/orders/R-test`]: () => ({ ...order, status: paid ? 'PAID' : 'WAITING' }),
    [`POST ${RECHARGE}/orders/R-test/refresh`]: (call) => { assert.equal(call.body, undefined); paid = true; return { ...order, status: 'PAID' }; },
  });
  await f.service.start();
  assert.deepEqual(await f.service.getRechargeOptions(), [{ id: '1', name: '商品', amountYuan: '1.01', rechargePoint: '1010' }]);
  const created = await f.service.createRechargeOrder({ productId: '1' });
  assert.equal(created.status, 'WAITING');
  assert.equal((await f.service.getRechargeOrder('R-test')).qrCode, created.qrCode);
  const revision = f.service.getState().balanceRevision;
  const refreshed = await f.service.getRechargeOrder('R-test', true);
  assert.equal(refreshed.status, 'PAID');
  assert.equal(refreshed.qrCode, null);
  assert.ok(f.service.getState().balanceRevision > revision);
  assert.equal(f.calls.filter((call) => call.method === 'POST' && call.url.pathname === `${RECHARGE}/orders`).length, 1);
});

test('消费及订单多取一条分页，历史来源不提交 subject 参数，遮蔽余额保持 null', async (t) => {
  const f = fixture(t, {
    ['GET /qhp-yibiao/anonymous/yibiao/finance/consumptions']: (call) => {
      assert.equal(call.url.search, '?offset=5&limit=6&sourceAccountId=34');
      return Array.from({ length: 6 }, (_, i) => ({ id: i + 1, operationType: 'IMAGE_GENERATION', consumePoint: 17, availableAfter: null }));
    },
    [`GET ${RECHARGE}/orders`]: (call) => {
      if (call.url.searchParams.get('sourceAccountId') !== '34') return [];
      assert.equal(call.url.search, '?offset=0&limit=6&sourceAccountId=34');
      return Array.from({ length: 6 }, (_, i) => ({ ...order, id: String(i + 1), orderNo: `R-${i}` }));
    },
  });
  await f.service.start();
  const consumption = await f.service.getTransactions({ page: 2, sourceAccountId: '34' });
  assert.equal(consumption.records.length, 5);
  assert.equal(consumption.hasMore, true);
  assert.equal(consumption.records[0].consumePoint, '17');
  assert.equal(consumption.records[0].availableAfter, null);
  const orders = await f.service.getRechargeOrders({ page: 1, sourceAccountId: '34' });
  assert.equal(orders.records.length, 5);
  assert.equal(orders.hasMore, true);
});

test('兑换只传 code，开票首次不带版本/重提携带版本，退款无请求体', async (t) => {
  const applications = [];
  const f = fixture(t, {
    [`POST ${OPEN}/email/login`]: () => ({ token: emailToken() }),
    [`POST ${TEAM}/redeem`]: (call) => { assert.deepEqual(call.body, { code: 'TEST' }); return { pointValue: 100 }; },
    [`GET ${TEAM}/recharge/orders/R-test/invoice`]: () => null,
    [`POST ${TEAM}/recharge/orders/R-test/invoice`]: (call) => { applications.push(call.body); return { status: 'PENDING', version: 1 }; },
    [`GET ${TEAM}/recharge/orders/R-test/refunds`]: () => [{ refundNo: 'RF-test', status: 'PENDING' }],
    [`POST ${TEAM}/recharge/orders/R-test/refunds`]: (call) => { assert.equal(call.body, undefined); return { refundNo: 'RF-test', status: 'PENDING' }; },
    [`GET ${RECHARGE}/orders/R-test`]: () => ({ ...order, status: 'PAID', refundStatus: 'PENDING' }),
  });
  await f.service.start();
  await f.service.loginWithEmail({ email: 'test@example.com', code: '123456' });
  assert.deepEqual(await f.service.redeemCode({ code: 'TEST' }), { pointValue: '100' });
  assert.equal(await f.service.getInvoiceApplication('R-test'), null);
  const input = { orderNo: 'R-test', titleType: 'PERSONAL', invoiceTitle: '测试', taxpayerNo: '', receiverEmail: 'test@example.com' };
  await f.service.createInvoiceApplication(input);
  await f.service.createInvoiceApplication({ ...input, version: 3 });
  assert.equal(applications[0].version, undefined);
  assert.equal(applications[1].version, 3);
  assert.equal(applications[0].orderNo, undefined);
  assert.equal(applications[0].remark, undefined);
  assert.equal((await f.service.createRefund('R-test')).status, 'PENDING');
  assert.equal((await f.service.getRefunds('R-test'))[0].refundNo, 'RF-test');
});

test('V4增量：普通成员自动取得可用 Key，使用 JWT 且不向界面暴露凭据', async (t) => {
  const f = fixture(t, {
    [`POST ${OPEN}/email/login`]: () => ({ token: emailToken() }),
    [`GET ${TEAM}/team/mine`]: () => [{ tenantId: 90, name: '测试团队', isAdmin: false }],
    [`GET ${TEAM}/api-keys/available`]: (call) => {
      assert.ok(call.headers.Authorization.startsWith('Bearer '));
      assert.equal(call.headers['X-Yibiao-Open-Token'], undefined);
      assert.equal(call.url.search, '');
      assert.equal(call.body, undefined);
      // 新合同只有 id/name/keyValue/expireTime，没有 status。
      return [
        { id: '92', name: '其他用途', keyValue: 'other-team-key', expireTime: null },
        { id: '91', name: '易标开源版', keyValue: 'member-team-key', expireTime: null },
      ];
    },
  });
  await f.service.start();
  f.routes[`GET ${OPEN}/account`] = () => ({ ...account, accountId: null, subjectType: 'TENANT', subjectId: 90 });
  const states = [];
  f.service.onChanged((state) => states.push(state));
  const state = await f.service.loginWithEmail({ email: 'member@example.com', code: '123456' });
  assert.equal(state.isTeamAdmin, false);
  assert.equal(state.error, '');
  assert.equal(f.configStore.load().text_model_profiles.official.api_key, 'member-team-key');
  assert.equal(JSON.stringify(states).includes('member-team-key'), false);
  assert.equal(f.calls.filter((call) => call.url.pathname === `${TEAM}/api-keys`).length, 0);
});

for (const isAdmin of [false, true]) {
  test(`V4增量：可用 Key 为空时${isAdmin ? '管理员创建一次' : '普通成员提示管理员且不创建'}`, async (t) => {
    const f = fixture(t, {
      [`POST ${OPEN}/email/login`]: () => ({ token: emailToken() }),
      [`GET ${TEAM}/team/mine`]: () => [{ tenantId: 90, name: '测试团队', isAdmin }],
      [`GET ${TEAM}/api-keys/available`]: () => [],
      [`POST ${TEAM}/api-keys`]: (call) => {
        assert.ok(isAdmin);
        assert.deepEqual(call.body, { name: '易标开源版' });
        return { id: '91', name: '易标开源版', keyValue: 'created-team-key', status: 'ACTIVE' };
      },
    });
    await f.service.start();
    f.routes[`GET ${OPEN}/account`] = () => ({ ...account, accountId: null, subjectType: 'TENANT', subjectId: 90 });
    const login = f.service.loginWithEmail({ email: 'member@example.com', code: '123456' });
    if (isAdmin) await login;
    else await assert.rejects(login, /请联系团队管理员创建/);
    assert.equal(f.configStore.load().text_model_profiles.official.api_key, isAdmin ? 'created-team-key' : '');
    assert.equal(f.service.getState().status, 'signed-in');
    assert.equal(f.calls.filter((call) => call.url.pathname === `${TEAM}/api-keys` && call.method === 'POST').length, isAdmin ? 1 : 0);
    assert.equal(f.calls.filter((call) => call.url.pathname === `${TEAM}/api-keys` && call.method === 'GET').length, 0);
  });
}

for (const scenario of [
  { name: '匿名关单成功清除二维码并广播状态', status: 'CLOSED', failure: false, email: false },
  { name: '邮箱关单遇付款抢先完成按已支付刷新余额', status: 'PAID', failure: false, email: true },
  { name: '关单响应失败只读回已关闭状态且不重发', status: 'CLOSED', failure: true, email: false },
  { name: '关单结果未确认保留待付单和二维码', status: 'WAITING', failure: true, email: false },
]) {
  test(`V4增量：${scenario.name}`, async (t) => {
    let status = 'WAITING';
    let email = false;
    const qrCode = 'data:image/png;base64,dGVzdA==';
    const f = fixture(t, {
      [`POST ${OPEN}/email/login`]: () => { email = true; return { token: emailToken() }; },
      [`GET ${OPEN}/account`]: () => ({ ...account, subjectType: email ? 'TENANT' : 'OPEN_ACCOUNT', subjectId: email ? 90 : 34, availablePoint: status === 'PAID' ? 2010 : 1000 }),
      [`POST ${RECHARGE}/orders`]: () => ({ order, qrCode, codeUrl: 'weixin://test', prepayStatus: 'READY' }),
      [`GET ${RECHARGE}/orders/R-test`]: () => ({ ...order, status }),
      [`POST ${RECHARGE}/orders/R-test/close`]: (call) => {
        assert.equal(call.body, undefined);
        assert.equal(call.url.search, '');
        if (scenario.email) {
          assert.ok(call.headers.Authorization.startsWith('Bearer '));
          assert.equal(call.headers['X-Yibiao-Open-Token'], undefined);
        } else {
          assert.ok(call.headers['X-Yibiao-Open-Token'].startsWith('yb1.'));
          assert.equal(call.headers.Authorization, undefined);
        }
        status = scenario.status;
        if (scenario.failure) throw new TypeError('模拟关单响应丢失');
        return { ...order, status };
      },
    });
    await f.service.start();
    if (scenario.email) await f.service.loginWithEmail({ email: 'member@example.com', code: '123456' });
    await f.service.createRechargeOrder({ productId: '1' });
    const updates = [];
    f.service.onRechargeOrderChanged((item) => updates.push(item));
    const revision = f.service.getState().balanceRevision;
    const result = f.service.closeRechargeOrder('R-test');
    if (scenario.failure) await assert.rejects(result, /暂时无法连接官方账户服务/);
    else assert.equal((await result).status, scenario.status);
    assert.equal(updates.at(-1).status, scenario.status);
    assert.equal(updates.at(-1).qrCode, null);
    assert.equal(f.service.getState().availablePoint, scenario.status === 'PAID' ? '2010' : '1000');
    if (scenario.status === 'PAID') assert.ok(f.service.getState().balanceRevision > revision);
    const latest = await f.service.getRechargeOrder('R-test');
    assert.equal(latest.qrCode, scenario.status === 'WAITING' ? qrCode : null);
    assert.equal(f.calls.filter((call) => call.url.pathname === `${RECHARGE}/orders/R-test/close`).length, 1);
    assert.equal(f.calls.filter((call) => call.url.pathname === `${RECHARGE}/orders` && call.method === 'POST').length, 1);
  });
}
