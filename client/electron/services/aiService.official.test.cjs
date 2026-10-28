const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { createAiService } = require('./aiService.cjs');
const { AI_BASE_URL } = require('./officialApi.cjs');
const { isOfficialBalanceInsufficient } = require('../utils/aiHttpError.cjs');

// 只暴露现有内部流消费器做纯内存检查，不启动 HTTP 服务或 Agent。
const proxyFile = require.resolve('./agent/agentOpenAiProxy.cjs');
const proxyModule = new Module(proxyFile, module);
proxyModule.filename = proxyFile;
proxyModule.paths = Module._nodeModulePaths(require('node:path').dirname(proxyFile));
proxyModule._compile(`${fs.readFileSync(proxyFile, 'utf-8')}\nmodule.exports = { prepareProxyResponse };`, proxyFile);
const { prepareProxyResponse } = proxyModule.exports;

const config = {
  text_model_provider: 'official', api_key: 'test-key', base_url: AI_BASE_URL, model_name: 'REASONING',
  request_mode: 'normal', concurrency_limit: 2, output_token_limit: 128,
  text_model_profiles: { official: { api_key: 'test-key' } },
  image_model: { provider: 'official', model_name: 'IMAGE_GENERATION', api_key: 'test-key', base_url: AI_BASE_URL, image_size: '1024x1024', request_mode: 'stream' },
};
const request = { messages: [{ role: 'user', content: '仅测试' }] };
const data = (value) => `data: ${JSON.stringify(value)}\n\n`;

function sse(text) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset += 7));
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

function fixture(t, response, onOfficialRequestComplete = () => {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    // 即使启用了统计，也只能消费内存响应，禁止任何真实外部请求。
    if (url === 'https://analytics.agnet.top/track') return Response.json({ ok: true });
    calls.push({ url, ...init, body: JSON.parse(init.body) });
    return response();
  });
  return { calls, service: createAiService({ app: {}, configStore: { load: () => config }, onOfficialRequestComplete }) };
}

test('官方文本强制 SSE，跨字节中文、心跳、用量及 DONE 完整消费', async (t) => {
  let completed = 0;
  const f = fixture(t, () => sse(`: heartbeat\r\n\r\n${data({ choices: [{ delta: { content: '测试成功' }, finish_reason: 'stop' }] })}${data({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } })}data: [DONE]\n\n`), () => { completed++; });
  assert.equal(await f.service.chat(request), '测试成功');
  assert.equal(completed, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${AI_BASE_URL}/chat/completions`);
  assert.equal(f.calls[0].body.model, 'REASONING');
  assert.equal(f.calls[0].body.stream, true);
});

test('官方文本 EOF 缺 DONE 和 event:error 均失败且不自动重放', async (t) => {
  let stream = data({ choices: [{ delta: { content: '半个结果' }, finish_reason: 'stop' }] });
  const f = fixture(t, () => sse(stream));
  await assert.rejects(f.service.chat(request), /未收到完成标记/);
  assert.equal(f.calls.length, 1);
  stream = `event: error\n${data({ error: { type: 'upstream_error', code: 'insufficient_balance', message: '余额不足' } })}`;
  await assert.rejects(f.service.chat(request), (error) => {
    assert.equal(error.aiRequestRetryable, false);
    assert.ok(isOfficialBalanceInsufficient(error.aiHttpError));
    return true;
  });
  assert.equal(f.calls.length, 2);
  assert.equal(isOfficialBalanceInsufficient({ source: 'custom-image-model', body: JSON.stringify({ error: { code: 'insufficient_balance' } }) }), false);
});

test('官方图片完成事件以正常 EOF 结束，不携带 response_format，JSON 模式同样支持', async (t) => {
  let stream = true;
  const f = fixture(t, () => stream ? sse(`: waiting\n\n${data({ type: 'image_generation.completed', b64_json: 'dGVzdA==' })}`) : Response.json({ data: [{ url: 'https://example.invalid/image.png' }] }));
  const result = await f.service.testImageModel(config);
  assert.equal(result.image_data, 'dGVzdA==');
  assert.equal(f.calls[0].url, `${AI_BASE_URL}/images/generations`);
  assert.equal(f.calls[0].body.response_format, undefined);
  assert.equal(f.calls[0].body.model, 'IMAGE_GENERATION');
  assert.equal(f.calls[0].body.n, 1);
  stream = false;
  const normal = await f.service.testImageModel({ ...config, image_model: { ...config.image_model, request_mode: 'normal' } });
  assert.equal(normal.image_url, 'https://example.invalid/image.png');
  assert.equal(f.calls[1].body.stream, false);
});

test('官方图片心跳后空 EOF 不算完成；余额通知失败不覆盖模型成功结果', async (t) => {
  let image = true;
  const f = fixture(t, () => image ? sse(': heartbeat\n\n') : sse(`${data({ choices: [{ delta: { content: '成功' } }] })}data: [DONE]\n\n`), () => { throw new Error('模拟配置读取失败'); });
  t.mock.method(console, 'warn', () => {});
  await assert.rejects(f.service.testImageModel(config), /未收到完整图片/);
  assert.equal(f.calls.length, 1);
  image = false;
  assert.equal(await f.service.chat(request), '成功');
});

test('Agent 转发保留工具调用与用量；官方缺 DONE 必须拒绝 completion 和响应流', async () => {
  const tool = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
  const prepare = (text) => prepareProxyResponse({ app: {}, config, runtimeMeta: { logModule: 'test' }, requestId: 'test', requestBody: { stream: true, ...request }, downstreamWantsStream: true, response: sse(text), startedAt: Date.now(), attempt: 1 });
  const complete = await prepare(`${data(tool)}${data({ usage: { prompt_tokens: 2 } })}data: [DONE]\n\n`);
  const [text, capture] = await Promise.all([complete.response.text(), complete.completion]);
  assert.ok(text.includes('call-1'));
  assert.equal(capture.usage.prompt_tokens, 2);
  const broken = await prepare(data(tool));
  const results = await Promise.allSettled([broken.response.text(), broken.completion]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'AI_STREAM_INCOMPLETE');
});

test('Agent 错误事件保留官方余额不足错误码', async () => {
  const prepared = await prepareProxyResponse({ app: {}, config, runtimeMeta: { logModule: 'test' }, requestId: 'test', requestBody: { stream: true, ...request }, downstreamWantsStream: true,
    response: sse(`event: error\n${data({ error: { type: 'upstream_error', code: 'insufficient_balance', message: '余额不足' } })}`), startedAt: Date.now(), attempt: 1 });
  const results = await Promise.allSettled([prepared.response.text(), prepared.completion]);
  assert.equal(results[1].status, 'rejected');
  assert.ok(isOfficialBalanceInsufficient(results[1].reason.aiHttpError));
});
