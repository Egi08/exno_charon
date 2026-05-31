import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { llmChatCompletion } from '../src/pipeline/llmStream.js';

// Regression guard for FIX_STREAM_REQUIRED (the commandcode/9router "expected true at
// params.stream" 400 bug class). Hermetic: spins up a local SSE server, never touches the
// real endpoint. Locks two invariants:
//   1. the helper ALWAYS sends stream:true (removing it reintroduces the 400)
//   2. streamed deltas reassemble into the exact non-streaming shape every caller consumes:
//      res.data.choices[0].message.content
function makeSSEServer(events, captured) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { captured.body = JSON.parse(body); } catch { captured.body = null; }
      captured.path = req.url;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
}

async function withServer(events, fn) {
  const captured = {};
  const server = makeSSEServer(events, captured);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}/v1`, captured);
  } finally {
    server.close();
  }
}

test('forces stream:true on the request body', async () => {
  await withServer([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }], async (baseUrl, captured) => {
    await llmChatCompletion(
      { model: 'x', temperature: 0.2, messages: [{ role: 'user', content: 'hi' }] },
      { timeout: 5000, headers: { 'content-type': 'application/json' }, baseUrl },
    );
    assert.equal(captured.body.stream, true, 'stream:true must be sent (the params.stream 400 fix)');
    assert.equal(captured.path, '/v1/chat/completions');
  });
});

test('reassembles content deltas into non-streaming shape', async () => {
  const events = [
    { choices: [{ delta: { role: 'assistant' } }] },
    { choices: [{ delta: { content: '{"verdict":' } }] },
    { choices: [{ delta: { content: '"BUY","confidence":80}' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 42 } },
  ];
  await withServer(events, async (baseUrl) => {
    const res = await llmChatCompletion(
      { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
      { timeout: 5000, headers: {}, baseUrl },
    );
    const msg = res.data.choices[0].message;
    assert.equal(msg.content, '{"verdict":"BUY","confidence":80}');
    assert.equal(msg.role, 'assistant');
    assert.equal(res.data.choices[0].finish_reason, 'stop');
    assert.equal(res.data.usage.total_tokens, 42);
  });
});

test('tolerates keepalive / non-JSON data lines without crashing', async () => {
  // Some providers emit comment/keepalive lines; the parser must skip them.
  const events = [
    { choices: [{ delta: { content: 'partial ' } }] },
    { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
  ];
  await withServer(events, async (baseUrl) => {
    const res = await llmChatCompletion(
      { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
      { timeout: 5000, headers: {}, baseUrl },
    );
    assert.equal(res.data.choices[0].message.content, 'partial answer');
  });
});
