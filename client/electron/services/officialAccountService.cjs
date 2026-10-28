const fs = require('node:fs');
const path = require('node:path');
const { getOfficialApiSessionFilePath, getOfficialRechargeQrCachePath } = require('../utils/paths.cjs');
const { fetchWithRedirect } = require('../utils/fetchWithRedirect.cjs');
const { SERVICE_BASE_URL } = require('./officialApi.cjs');

const API_BASE_URL = `${SERVICE_BASE_URL}/anonymous/yibiao/open`;
const RECHARGE_BASE_URL = `${SERVICE_BASE_URL}/anonymous/yibiao/recharge`;
const TEAM_RECHARGE_BASE_URL = `${SERVICE_BASE_URL}/yibiao/recharge`;
const PAGE_SIZE = 5;
const EMAIL_REFRESH_INTERVAL = 60 * 60 * 1000;
const QR_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
const QR_CACHE_CLEANUP_INTERVAL = 30 * 60 * 1000;

// 原子保存 UTF-8 JSON，避免退出或断电留下半个文件。
function writeJsonAtomic(filePath, value) {
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tempFile, filePath);
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
}

function amountYuan(fen) {
  const value = BigInt(fen);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

function orderView(order) {
  return { ...order, id: String(order.id), sourceSubjectId: String(order.sourceSubjectId),
    settledSubjectId: order.settledSubjectId == null ? null : String(order.settledSubjectId),
    rechargePoint: String(order.rechargePoint), amountYuan: amountYuan(order.payAmountFen), qrCode: null };
}

function pageQuery({ page, sourceAccountId }) {
  const query = new URLSearchParams({ offset: String((page - 1) * PAGE_SIZE), limit: String(PAGE_SIZE + 1) });
  if (sourceAccountId) query.set('sourceAccountId', sourceAccountId);
  return query;
}

// 管理官方账户会话；所有身份变更在 Main 中串行执行，令牌不发送给页面。
function createOfficialAccountService({ app, configStore, powerMonitor, fetchImpl = fetch }) {
  const sessionFile = getOfficialApiSessionFilePath(app);
  const qrCacheFile = getOfficialRechargeQrCachePath(app);
  const listeners = new Set();
  const orderListeners = new Set();
  const orderStatuses = new Map();
  const pendingOrders = new Set();
  const shutdown = new AbortController();
  let session = null;
  let clientId = '';
  let loading = true;
  let sessionError = '';
  let apiKeyError = '';
  let closed = false;
  let startPromise = null;
  let tail = Promise.resolve();
  let refreshTimer = null;
  let refreshAt = 0;
  let orderTimer = null;
  let orderTrackingStarted = false;
  let reloadOrders = false;
  let balanceNeedsRefresh = false;
  let balanceRetryAt = 0;
  let orderRetryAt = 0;
  let creatingOrder = null;
  let refreshingBalance = null;
  let qrCodes = [];
  let qrCleanupTimer = null;
  let balanceRevision = 0;
  const settlementTimers = new Map();

  // 仅返回页面需要的账户展示状态。
  function getState() {
    const account = session && session.expiresAt > Date.now() ? session.account : null;
    return {
      status: loading ? 'loading' : account ? 'signed-in' : 'signed-out',
      clientId,
      identityType: account ? session.kind : null,
      error: apiKeyError || sessionError,
      email: account ? session.email || null : null,
      accountId: account?.accountId || null,
      availablePoint: account?.availablePoint ?? null,
      subjectId: account?.subjectId ?? null,
      teamName: account?.teamName ?? null,
      isTeamAdmin: account?.isTeamAdmin === true,
      netRechargePoint: account?.netRechargePoint ?? null,
      totalConsumePoint: account?.totalConsumePoint ?? null,
      balanceRevision,
      sources: account?.sources?.map(({ sourceAccountId }) => ({ sourceAccountId: String(sourceAccountId) })) || [],
    };
  }

  // 向所有账户页面同步最新状态。
  function publish() {
    if (closed) return;
    const state = getState();
    listeners.forEach((listener) => listener(state));
  }

  // 顺序处理登录、绑定和刷新，防止旧响应覆盖新令牌。
  function enqueue(operation) {
    const result = tail.then(() => {
      if (closed) throw new Error('官方账户服务已关闭');
      return operation();
    });
    tail = result.catch(() => undefined);
    return result;
  }

  // 保存最新会话后更新内存令牌。
  function persist(nextSession) {
    writeJsonAtomic(sessionFile, nextSession);
    session = nextSession;
  }

  // 缓存磁盘异常不能中断支付确认和余额更新。
  function saveQrCodes() {
    try {
      if (qrCodes.length) writeJsonAtomic(qrCacheFile, qrCodes);
      else fs.rmSync(qrCacheFile, { force: true });
    } catch (error) {
      console.warn('[official-account] 支付二维码缓存写入失败', error);
    }
  }

  // 保留上限是本地清理规则，不代表微信二维码的有效期。
  function pruneQrCodes() {
    const retained = qrCodes.filter((item) => Date.now() - item.cachedAt < QR_CACHE_MAX_AGE);
    if (retained.length === qrCodes.length) return;
    qrCodes = retained;
    saveQrCodes();
  }

  // 未登录时也定期清理，避免其他账户的缓存长期残留。
  function scheduleQrCleanup() {
    qrCleanupTimer = setTimeout(() => {
      void enqueue(() => { pruneQrCodes(); scheduleQrCleanup(); }).catch(() => undefined);
    }, QR_CACHE_CLEANUP_INTERVAL);
    qrCleanupTimer.unref?.();
  }

  // 失效会话停止刷新，并静默回到未登录状态。
  function clearSession(message = '') {
    settlementTimers.forEach(clearTimeout);
    settlementTimers.clear();
    resetOrderTracking();
    clearTimeout(refreshTimer);
    refreshTimer = null;
    refreshAt = 0;
    session = null;
    configStore.save({ official_api_version: 4, text_model_profiles: { official: { api_key: '' } } });
    sessionError = message;
    apiKeyError = '';
    loading = false;
    publish();
    fs.rmSync(sessionFile, { force: true });
  }

  // 官方接口统一响应解析；网络异常可在当前令牌有效期内重试。
  async function request(endpoint, { body, authenticated = false, method = 'POST', baseUrl = API_BASE_URL } = {}) {
    const remaining = session ? session.expiresAt - Date.now() : 0;
    if (authenticated && remaining <= 0) {
      clearSession('登录已失效，请重新登录官方账户');
      throw new Error('请先登陆官方账户');
    }
    const headers = { 'Content-Type': 'application/json' };
    if (authenticated) {
      if (session.kind === 'email') headers.Authorization = `Bearer ${session.token}`;
      else headers['X-Yibiao-Open-Token'] = session.token;
    }
    const signal = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(Math.max(1, Math.floor(authenticated ? Math.min(15000, remaining) : 15000))),
    ]);
    let response;
    try {
      // 服务端以 307 跳转到实际入口，需保留鉴权头。
      response = await fetchWithRedirect(`${baseUrl}${endpoint}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
      }, fetchImpl);
    } catch (error) {
      throw Object.assign(new Error('暂时无法连接官方账户服务，请稍后重试', { cause: error }), { retryable: true });
    }
    // 认证失效以 HTTP 状态为准，即使错误正文不是 JSON 也应退出失效会话。
    if (authenticated && response.status === 401) clearSession('登录已失效，请重新登录官方账户');
    let result;
    try {
      // V4 的 Long 编号与点数即使以 JSON 数字返回，也不能经过 JS 浮点数舍入。
      result = JSON.parse(await response.text(), (_key, value, context) => (
        typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
          ? context.source : value
      ));
    } catch (error) {
      throw Object.assign(new Error('官方账户响应读取失败，请稍后重试', { cause: error }), {
        retryable: response.status >= 500 || error instanceof TypeError,
      });
    }
    if (closed) throw new Error('官方账户服务已关闭');
    if (!response.ok || !result || (result.code !== 0 && result.code !== 200)) {
      throw Object.assign(new Error(result?.msg || result?.errorMsg || `官方账户请求失败（${response.status}）`), { retryable: response.status >= 500 });
    }
    return result.data;
  }

  // 邮箱身份读取成员可用列表；优先复用同名 Key，仅匿名账户或团队管理员可在空列表时创建。
  async function syncApiKey() {
    try {
      const isEmail = session.kind === 'email';
      const keyOptions = isEmail ? { baseUrl: `${SERVICE_BASE_URL}/yibiao` } : {};
      const keys = await request(isEmail ? '/api-keys/available' : '/api-keys', { ...keyOptions, method: 'GET', authenticated: true });
      if (!Array.isArray(keys)) throw new Error('API Key 列表格式不正确');
      const available = isEmail ? keys : keys.filter((item) => item.status === 'ACTIVE'
        && (!item.expireTime || Date.parse(item.expireTime) > Date.now()));
      let key = available.find((item) => item.name === '易标开源版') || available[0];
      if (!key) {
        if (session.kind === 'email' && !session.account?.isTeamAdmin) throw new Error('当前团队没有可用 API Key，请联系团队管理员创建');
        key = await request('/api-keys', { ...keyOptions, body: { name: '易标开源版' }, authenticated: true });
      }
      if (typeof key?.keyValue !== 'string' || !key.keyValue.trim()) throw new Error('接口未返回完整 API Key');
      configStore.save({ official_api_version: 4, text_model_profiles: { official: { api_key: key.keyValue } } });
      apiKeyError = '';
    } catch (error) {
      apiKeyError = `获取官方 API Key 失败：${error.message}`;
      throw new Error(apiKeyError, { cause: error });
    } finally {
      loading = false;
      publish();
    }
  }

  // 安排唯一的刷新任务，网络重试也使用同一个计时器。
  function scheduleRefresh(delay) {
    clearTimeout(refreshTimer);
    refreshAt = Date.now() + delay;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void enqueue(() => refreshSession()).catch(() => undefined);
    }, Math.max(1, delay));
    refreshTimer.unref?.();
  }

  // 接收服务端签发的新令牌，立即保存并按有效期的 80% 安排刷新。
  function acceptAnonymousToken(token, account = session?.account || null) {
    // yb1 载荷最后一项为签发秒数，服务端有效期固定 15 分钟；这里只用于安排刷新。
    const fields = typeof token === 'string' ? Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf-8').split(':') : [];
    const expiresAt = (Number(fields[5]) + 900) * 1000;
    const lifetime = expiresAt - Date.now();
    if (!token?.startsWith('yb1.') || fields.length !== 6 || !Number.isFinite(lifetime) || lifetime <= 0) {
      throw new Error('官方账户接口未返回有效令牌');
    }
    persist({
      token,
      kind: 'anonymous',
      expiresAt,
      account,
    });
    sessionError = '';
    scheduleRefresh(lifetime * 0.8);
  }

  // 邮箱响应使用 QHP JWT；读取 exp 安排本机到期检查，签名与权限由服务端验证。
  function acceptEmailLogin(login, email = session?.email, account = session?.account) {
    let expiresAt;
    try {
      expiresAt = Number(JSON.parse(Buffer.from(login.token.split('.')[1], 'base64url').toString('utf-8')).exp) * 1000;
    } catch {
      throw new Error('官方账户接口未返回有效的邮箱登录令牌');
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('邮箱登录令牌已过期，请重新登录');
    persist({ kind: 'email', token: login.token, expiresAt, email, account });
    sessionError = '';
    scheduleRefresh(Math.min(EMAIL_REFRESH_INTERVAL, expiresAt - Date.now()));
  }

  // 保存账户展示字段，余额保留服务端字符串精度。
  async function readAccount() {
    const account = await request('/account', { method: 'GET', authenticated: true });
    let team = null;
    if (session.kind === 'email') {
      const teams = await request('/yibiao/team/mine', { method: 'GET', authenticated: true, baseUrl: SERVICE_BASE_URL });
      team = teams.find((item) => String(item.tenantId) === String(account.subjectId));
    }
    return { ...account, teamName: team?.name || null, isTeamAdmin: team?.isAdmin === true };
  }

  function acceptAccount(account) {
    persist({ ...session, account: { ...account,
      accountId: account.accountId == null ? null : String(account.accountId),
      subjectId: String(account.subjectId),
      availablePoint: String(account.availablePoint),
      netRechargePoint: String(account.netRechargePoint),
      totalConsumePoint: String(account.totalConsumePoint),
    } });
    balanceRevision++;
    loading = false;
    sessionError = '';
    publish();
  }

  // 后台业务或临时服务失败保留仍有效的会话；只有失效或到期才退出。
  function handleAutomaticFailure(error) {
    if (closed) return;
    loading = false;
    const remaining = session ? session.expiresAt - Date.now() : 0;
    if (remaining > 0) {
      sessionError = error.message;
      scheduleRefresh(Math.min(error.retryable ? 30000 : session.kind === 'email' ? EMAIL_REFRESH_INTERVAL : remaining * 0.8, remaining));
      publish();
    } else {
      clearSession(sessionError || error.message);
    }
  }

  // 刷新现有会话，并同步查询最新账户邮箱和余额。
  async function refreshSession() {
    try {
      if (!session || session.expiresAt <= Date.now()) {
        clearSession('登录已失效，请重新登录官方账户');
        return;
      }
      if (session.kind === 'email') acceptEmailLogin(await request('/openUser/refresh-token', { method: 'GET', authenticated: true, baseUrl: SERVICE_BASE_URL }));
      else acceptAnonymousToken(await request('/tokens/refresh', { authenticated: true }));
      acceptAccount(await readAccount());
      if (!orderTrackingStarted) beginOrderTracking();
      if (apiKeyError) await syncApiKey();
      return true;
    } catch (error) {
      handleAutomaticFailure(error);
    }
  }

  // 休眠恢复后按真实时钟重新判断是否到期或需要刷新。
  function handleResume() {
    if (closed) return;
    void enqueue(pruneQrCodes).catch(() => undefined);
    if (!session) return;
    if (Date.now() >= refreshAt || Date.now() >= session.expiresAt) {
      clearTimeout(refreshTimer);
      void enqueue(() => refreshSession()).catch(() => undefined);
    } else {
      scheduleRefresh(refreshAt - Date.now());
    }
  }

  // 邮箱会话启动时刷新；匿名会话每次启动重新注册，不使用缓存令牌续期。
  function start() {
    if (startPromise) return startPromise;
    powerMonitor.on('resume', handleResume);
    startPromise = enqueue(async () => {
      try {
        if (fs.existsSync(qrCacheFile)) qrCodes = JSON.parse(fs.readFileSync(qrCacheFile, 'utf-8'));
        pruneQrCodes();
      } catch (error) {
        console.warn('[official-account] 支付二维码缓存读取失败', error);
      }
      scheduleQrCleanup();
      try {
        clientId = configStore.load().analytics_client_id;
        configStore.save({ official_api_version: 4, text_model_profiles: { official: { api_key: '' } } });
        publish();
        if (fs.existsSync(sessionFile)) session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
        if (session?.kind === 'email') {
          if (await refreshSession()) await syncApiKey();
          return;
        }
        session = null;
        fs.rmSync(sessionFile, { force: true });
        acceptAnonymousToken(await request('/clients/login', { body: { clientId } }));
        acceptAccount(await readAccount());
        beginOrderTracking();
        await syncApiKey();
      } catch (error) {
        handleAutomaticFailure(error);
      }
    });
    return startPromise;
  }

  // 验证码只提交邮箱和用途，不携带 Client 身份或已有凭据。
  function sendEmailCode({ email, purpose }) {
    return enqueue(() => request('/email-codes', { body: { email, purpose } }));
  }

  // 使用邮箱验证码登录，保存该响应中的账户及新令牌。
  function loginWithEmail({ email, code }) {
    return enqueue(async () => {
      const result = await request('/email/login', { body: { email, code } });
      resetOrderTracking();
      settlementTimers.forEach(clearTimeout);
      settlementTimers.clear();
      configStore.save({ official_api_version: 4, text_model_profiles: { official: { api_key: '' } } });
      acceptEmailLogin(result, email, null);
      acceptAccount(await readAccount());
      beginOrderTracking();
      await syncApiKey();
      return getState();
    });
  }

  // 绑定邮箱可能合并账户，必须立即替换旧令牌及账户信息。
  function bindEmail({ email, code }) {
    return enqueue(async () => {
      const result = await request('/email/bind', { body: { email, code }, authenticated: true });
      resetOrderTracking();
      settlementTimers.forEach(clearTimeout);
      settlementTimers.clear();
      configStore.save({ official_api_version: 4, text_model_profiles: { official: { api_key: '' } } });
      acceptEmailLogin(result, email, null);
      acceptAccount(await readAccount());
      beginOrderTracking();
      await syncApiKey();
      return getState();
    });
  }

  // 页面和手动刷新共用同一请求，沿用当前会话查询并广播最新余额。
  function refreshBalance() {
    if (refreshingBalance) return refreshingBalance;
    refreshingBalance = enqueue(async () => {
      acceptAccount(await readAccount());
      if (apiKeyError) await syncApiKey();
      return getState();
    }).finally(() => { refreshingBalance = null; });
    return refreshingBalance;
  }

  // 扣点异步入账；合并批量生成的通知并有限次回读，不以生成成功冒充扣点已完成。
  function notifyAiCompleted(apiKey) {
    if (closed || !session || apiKey !== configStore.load().text_model_profiles.official.api_key) return;
    const identity = `${session.kind}:${session.account?.subjectId}`;
    for (const delay of [500, 3000, 10000]) {
      if (delay !== 10000 && settlementTimers.has(delay)) continue;
      clearTimeout(settlementTimers.get(delay));
      const timer = setTimeout(() => {
        settlementTimers.delete(delay);
        if (closed || `${session?.kind}:${session?.account?.subjectId}` !== identity) return;
        void refreshBalance().catch(() => undefined);
      }, delay);
      settlementTimers.set(delay, timer);
      timer.unref?.();
    }
  }

  // 兑换成功后查询当前团队余额。
  function redeemCode(input) {
    return enqueue(async () => {
      const result = await request('/yibiao/redeem', { baseUrl: SERVICE_BASE_URL, body: input, authenticated: true });
      balanceNeedsRefresh = true;
      balanceRetryAt = 0;
      await refreshPaidBalance();
      scheduleOrderCheck();
      return { pointValue: String(result.pointValue) };
    });
  }

  // 提交一次开票申请，沿用当前账户的认证请求，不自动重发。
  function createInvoiceApplication({ orderNo, ...body }) {
    return enqueue(() => request(`/orders/${encodeURIComponent(orderNo)}/invoice`, {
      baseUrl: TEAM_RECHARGE_BASE_URL, body, authenticated: true,
    }));
  }

  function getInvoiceApplication(orderNo) {
    return enqueue(() => request(`/orders/${encodeURIComponent(orderNo)}/invoice`, {
      baseUrl: TEAM_RECHARGE_BASE_URL, method: 'GET', authenticated: true,
    }));
  }

  function getRefunds(orderNo) {
    return enqueue(() => request(`/orders/${encodeURIComponent(orderNo)}/refunds`, {
      baseUrl: TEAM_RECHARGE_BASE_URL, method: 'GET', authenticated: true,
    }));
  }

  // 退款只显式提交一次，结果未确认时也重查原订单及余额，不自动重发。
  function createRefund(orderNo) {
    return enqueue(async () => {
      try {
        return await request(`/orders/${encodeURIComponent(orderNo)}/refunds`, {
          baseUrl: TEAM_RECHARGE_BASE_URL, authenticated: true,
        });
      } finally {
        balanceNeedsRefresh = true;
        balanceRetryAt = 0;
        try { await readRechargeOrder(orderNo); } catch { orderRetryAt = Date.now() + 30000; }
        await refreshPaidBalance();
        scheduleOrderCheck();
      }
    });
  }

  // 使用当前开放令牌查询商品，仅返回页面展示字段，不持久化商品列表。
  function getRechargeOptions() {
    return enqueue(async () => {
      const options = await request('/products', { baseUrl: RECHARGE_BASE_URL, method: 'GET', authenticated: true });
      return options.map(({ id, name, payAmountFen, rechargePoint }) => ({
        id: String(id), name, amountYuan: amountYuan(payAmountFen), rechargePoint: String(rechargePoint),
      }));
    });
  }

  // 账户变化、会话失效及退出时停止监控；二维码缓存单独管理。
  function resetOrderTracking() {
    orderTrackingStarted = false;
    clearTimeout(orderTimer);
    orderTimer = null;
    pendingOrders.clear();
    orderStatuses.clear();
    reloadOrders = false;
    balanceNeedsRefresh = false;
    balanceRetryAt = 0;
    orderRetryAt = 0;
  }

  // 登录完成后异步恢复待支付订单，不延迟登录响应。
  function beginOrderTracking() {
    resetOrderTracking();
    orderTrackingStarted = true;
    reloadOrders = true;
    scheduleOrderCheck(0);
  }

  // 所有订单请求使用现有串行队列，唯一计时器防止轮询重叠。
  function scheduleOrderCheck(delay = 5000) {
    clearTimeout(orderTimer);
    orderTimer = null;
    if (closed || !session || (!reloadOrders && !pendingOrders.size && !balanceNeedsRefresh)) return;
    const remaining = session.expiresAt - Date.now();
    orderTimer = setTimeout(() => {
      orderTimer = null;
      void enqueue(checkOrders).catch(() => undefined);
    }, Math.max(1, Math.min(remaining, Math.max(delay, orderRetryAt - Date.now()))));
    orderTimer.unref?.();
  }

  // 广播服务端状态；支付成功或关单后立即清除当前账户的二维码。
  function recordOrder(order) {
    const previous = orderStatuses.get(order.orderNo);
    if ((order.status === 'PAID' && previous?.status !== 'PAID')
      || (previous && previous.refundStatus !== order.refundStatus)) balanceNeedsRefresh = true;
    orderStatuses.set(order.orderNo, { status: order.status, refundStatus: order.refundStatus });
    if (order.status === 'WAITING' || order.refundStatus === 'PENDING') pendingOrders.add(order.orderNo);
    else pendingOrders.delete(order.orderNo);
    if (order.status !== 'WAITING') {
      const retained = qrCodes.filter((item) => item.orderNo !== order.orderNo);
      if (retained.length !== qrCodes.length) { qrCodes = retained; saveQrCodes(); }
    }
    orderListeners.forEach((listener) => listener({ ...order, qrCode: null }));
  }

  // 确认成功后立即查询余额；查询失败只重试余额，不回退支付状态。
  async function refreshPaidBalance() {
    if (!balanceNeedsRefresh || !session || closed || Date.now() < balanceRetryAt) return;
    try {
      acceptAccount(await readAccount());
      balanceNeedsRefresh = false;
      balanceRetryAt = 0;
    } catch {
      balanceRetryAt = Date.now() + 30000;
      orderRetryAt = balanceRetryAt;
    }
  }

  // 列表以服务端为准，同时恢复其中尚未完成的订单。
  async function readRechargeOrders(query = { page: 1 }) {
    const items = await request(`/orders?${pageQuery(query)}`, { baseUrl: RECHARGE_BASE_URL, method: 'GET', authenticated: true });
    const orders = items.slice(0, PAGE_SIZE).map(orderView);
    orders.forEach(recordOrder);
    await refreshPaidBalance();
    return { records: orders, current: query.page, size: PAGE_SIZE, hasMore: items.length > PAGE_SIZE };
  }

  // 重启后分页恢复本人所有来源的未完订单，不把列表第一页当作全部订单。
  async function restoreOrderTracking() {
    const sources = [null, ...(session.kind === 'email' ? session.account.sources.map((item) => item.sourceAccountId) : [])];
    for (const sourceAccountId of sources) {
      for (let offset = 0; ; offset += 100) {
        const query = new URLSearchParams({ offset: String(offset), limit: '100' });
        if (sourceAccountId) query.set('sourceAccountId', String(sourceAccountId));
        const orders = await request(`/orders?${query}`, { baseUrl: RECHARGE_BASE_URL, method: 'GET', authenticated: true });
        orders.forEach((order) => recordOrder(orderView(order)));
        if (orders.length < 100) break;
      }
    }
    reloadOrders = false;
    await refreshPaidBalance();
  }

  // 手动查询和后台确认走同一路径，成功状态必定触发余额查询。
  async function readRechargeOrder(orderNo, refresh = false) {
    const order = orderView(await request(`/orders/${encodeURIComponent(orderNo)}${refresh ? '/refresh' : ''}`, {
      baseUrl: RECHARGE_BASE_URL, method: refresh ? 'POST' : 'GET', authenticated: true,
    }));
    recordOrder(order);
    await refreshPaidBalance();
    return order;
  }

  // 关闭页面仍确认支付；断网后 30 秒重试，到期停止。
  async function checkOrders() {
    if (!session || session.expiresAt <= Date.now()) { clearSession('登录已失效，请重新登录官方账户'); return; }
    orderRetryAt = 0;
    try {
      if (reloadOrders) await restoreOrderTracking();
      else {
        for (const id of [...pendingOrders]) await readRechargeOrder(id);
        await refreshPaidBalance();
      }
    } catch {
      orderRetryAt = Date.now() + 30000;
    } finally {
      scheduleOrderCheck();
    }
  }

  // 创建只执行一次；失败后查询列表确认可能已落库的订单，不自动重发下单。
  function createRechargeOrder(input) {
    if (creatingOrder) return creatingOrder;
    creatingOrder = enqueue(async () => {
      try {
        const created = await request('/orders', { baseUrl: RECHARGE_BASE_URL, body: input, authenticated: true });
        const order = { ...orderView(created.order), qrCode: created.qrCode || null };
        if (order.status === 'WAITING' && order.qrCode) {
          qrCodes.push({ orderNo: order.orderNo, qrCode: order.qrCode, cachedAt: Date.now() });
          saveQrCodes();
        }
        recordOrder(order);
        await refreshPaidBalance();
        return order;
      } catch (error) {
        reloadOrders = true;
        try { await readRechargeOrders(); } catch { orderRetryAt = Date.now() + 30000; }
        throw error;
      } finally {
        scheduleOrderCheck();
      }
    }).finally(() => { creatingOrder = null; });
    return creatingOrder;
  }

  // 手动刷新列表后继续监控待支付订单。
  function getRechargeOrders(query) {
    return enqueue(async () => {
      try { return await readRechargeOrders(query); }
      finally { scheduleOrderCheck(); }
    });
  }

  // 两种登录身份共用消费接口，凭据及查询范围由现有账户鉴权处理。
  function getTransactions(query) {
    return enqueue(async () => {
      const data = await request(`/anonymous/yibiao/finance/consumptions?${pageQuery(query)}`, {
        baseUrl: SERVICE_BASE_URL, method: 'GET', authenticated: true,
      });
      return { records: data.slice(0, PAGE_SIZE).map((item) => ({ ...item,
        id: String(item.id), consumePoint: String(item.consumePoint),
        availableAfter: item.availableAfter == null ? null : String(item.availableAfter),
      })), current: query.page, size: PAGE_SIZE, hasMore: data.length > PAGE_SIZE };
    });
  }

  // 先查询服务端状态，仅为仍待支付的订单附上当前账户的有效本地缓存。
  function getRechargeOrder(orderNo, refresh = false) {
    return enqueue(async () => {
      try {
        const order = await readRechargeOrder(orderNo, refresh);
        pruneQrCodes();
        const cached = order.status === 'WAITING'
          ? qrCodes.find((item) => item.orderNo === order.orderNo)
          : null;
        return { ...order, qrCode: cached?.qrCode || null };
      }
      finally { scheduleOrderCheck(); }
    });
  }

  // 关单仅提交一次；以服务端实际状态更新二维码和余额，失败时只重查原单。
  function closeRechargeOrder(orderNo) {
    return enqueue(async () => {
      try {
        const order = orderView(await request(`/orders/${encodeURIComponent(orderNo)}/close`, {
          baseUrl: RECHARGE_BASE_URL, authenticated: true,
        }));
        recordOrder(order);
        await refreshPaidBalance();
        return order;
      } catch (error) {
        try { await readRechargeOrder(orderNo); } catch { orderRetryAt = Date.now() + 30000; }
        throw error;
      } finally {
        scheduleOrderCheck();
      }
    });
  }

  // 订阅不包含二维码的订单状态变化。
  function onRechargeOrderChanged(listener) {
    orderListeners.add(listener);
    return () => orderListeners.delete(listener);
  }

  // 订阅不包含令牌的账户状态。
  function onChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // 退出时取消网络请求及刷新任务，等待串行队列结束。
  function close() {
    closed = true;
    resetOrderTracking();
    clearTimeout(refreshTimer);
    clearTimeout(qrCleanupTimer);
    settlementTimers.forEach(clearTimeout);
    settlementTimers.clear();
    powerMonitor.removeListener('resume', handleResume);
    shutdown.abort();
    listeners.clear();
    orderListeners.clear();
    return tail;
  }

  return { start, getState, onChanged, sendEmailCode, loginWithEmail, bindEmail, refreshBalance, notifyAiCompleted, getRechargeOptions,
    redeemCode, createInvoiceApplication, getInvoiceApplication, getRefunds, createRefund,
    createRechargeOrder, getRechargeOrders, getTransactions, getRechargeOrder, closeRechargeOrder, onRechargeOrderChanged, close };
}

module.exports = { createOfficialAccountService };
