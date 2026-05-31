import axios from 'axios';

// FIX_STREAM_REQUIRED: the commandcode upstream behind 9router rejects a NON-streamed chat
// completion with HTTP 400 "Invalid input: expected true at \"params.stream\"". 9router routes
// across multiple upstream providers, so the failure is INTERMITTENT — a plain curl may hit a
// tolerant upstream and return 200 while the bot hits the strict one and 400s. The only reliable
// fix is to ALWAYS stream and reassemble the SSE chunks back into the non-streaming axios
// response shape every caller already expects: { data: { choices: [{ message: { role, content },
// finish_reason }] } }. This keeps `res.data?.choices?.[0]?.message?.content` working unchanged.
//
// Used by every Charon LLM call site (llm.js, adversarial.js, lessons.js, postmortem.js) which are
// all text-in/JSON-out (no tool calls), so we only need to accumulate `delta.content`.

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    let s = '';
    stream.on('data', (c) => { s += c.toString('utf8'); });
    stream.on('end', () => resolve(s));
    stream.on('error', reject);
  });
}

/**
 * Drop-in replacement for `axios.post(BASE/chat/completions, body, opts)`.
 * @param {object} body - OpenAI chat body (model, temperature, messages). `stream` is forced true.
 * @param {object} opts - { timeout, headers, baseUrl }
 * @returns {{ data: { choices: Array<{ message: {role,content}, finish_reason }>, usage } }}
 */
export async function llmChatCompletion(body, { timeout, headers, baseUrl } = {}) {
  // FIX_UA_REQUIRED: ai.masanto.id is behind Cloudflare Bot-Fight Mode which 403s
  // (error code 1010 / "blocked") on non-browser client signatures. axios' default UA
  // can be banned, so force a browser User-Agent for every Charon LLM call site.
  // Override via env LLM_USER_AGENT if the endpoint changes.
  const LLM_USER_AGENT = process.env.LLM_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const mergedHeaders = { 'User-Agent': LLM_USER_AGENT, ...(headers || {}) };
  // FIX_RATE_LIMIT: ai.masanto.id (Cloudflare-fronted, shared router) throttles bursts with
  // HTTP 429 "All connections are temporarily rate-limited", and Charon fires several LLM calls
  // per candidate cycle (decision + adversarial critic, possibly for concurrent candidates).
  // Failing the whole batch on the first 429 wastes the cycle AND the retry-storm self-exhausts
  // the key. Instead retry transient throttles (429/502/503/529) with exponential backoff + jitter,
  // honoring Retry-After when the server sends it. Tunable via env; defaults are conservative.
  const MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES || 4);
  const BASE_DELAY_MS = Number(process.env.LLM_RETRY_BASE_MS || 800);
  let res;
  for (let attempt = 0; ; attempt += 1) {
    try {
      res = await axios.post(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        { ...body, stream: true },
        { timeout, headers: mergedHeaders, responseType: 'stream' },
      );
      break;
    } catch (err) {
      // With responseType:'stream' an error body is itself a stream — drain it so the
      // thrown message is readable (otherwise callers log "[object Object]").
      if (err.response?.data && typeof err.response.data.on === 'function') {
        const text = await streamToString(err.response.data).catch(() => '');
        if (text) err.message = `${err.message} :: ${text.slice(0, 400)}`;
      }
      const status = err.response?.status;
      const retriable = status === 429 || status === 502 || status === 503 || status === 529;
      if (!retriable || attempt >= MAX_RETRIES) throw err;
      const retryAfterSec = Number(err.response?.headers?.['retry-after']);
      const backoff = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : BASE_DELAY_MS * (2 ** attempt) + Math.floor(Math.random() * 400);
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  let content = '';
  let role = 'assistant';
  let finishReason = null;
  let usage = null;
  let buffer = '';

  await new Promise((resolve, reject) => {
    res.data.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      // SSE lines are newline-delimited; JSON-encoded content keeps real newlines as \\n,
      // so splitting on a literal \n never bisects a payload.
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          if (json.usage) usage = json.usage;
          const choice = json.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};
          if (delta.role) role = delta.role;
          if (delta.content) content += delta.content;
          if (choice.finish_reason) finishReason = choice.finish_reason;
        } catch { /* partial/non-JSON keepalive line — ignore */ }
      }
    });
    res.data.on('end', resolve);
    res.data.on('error', reject);
  });

  return { data: { choices: [{ message: { role, content }, finish_reason: finishReason }], usage } };
}
