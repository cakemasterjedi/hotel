// Minimal client for remote MCP servers over Streamable HTTP.
// Enough for read-only tool calls: initialize, list tools, call tools.

const sessions = new Map(); // url -> { id, at }
const toolSchemas = new Map(); // url -> Map(name -> tool)
let rpcId = 1;

async function post(url, body, sessionId, timeoutMs) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': 'HotelHunter/1.0' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`);
  return { res, message: parseMessage(text, body.id) };
}

// Responses are either plain JSON or a server-sent-event stream.
function parseMessage(text, id) {
  if (!text.trim()) return null;
  const candidates = text.trimStart().startsWith('{')
    ? [text]
    : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  for (const c of candidates) {
    try {
      const msg = JSON.parse(c);
      if (id === undefined || msg.id === id || msg.result || msg.error) return msg;
    } catch { /* keep looking */ }
  }
  return null;
}

async function session(url) {
  const cached = sessions.get(url);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.id;
  const init = { jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hotel-hunter', version: '1.0' } } };
  const { res } = await post(url, init, null, 20_000);
  const id = res.headers.get('mcp-session-id');
  await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, id, 10_000).catch(() => {});
  sessions.set(url, { id, at: Date.now() });
  return id;
}

async function rpc(url, method, params, timeoutMs) {
  const id = rpcId++;
  let sid = await session(url);
  let out;
  try {
    out = await post(url, { jsonrpc: '2.0', id, method, params }, sid, timeoutMs);
  } catch (err) {
    // An expired session usually shows up as 400/404; re-initialise once.
    if (!/HTTP 40[04]/.test(err.message)) throw err;
    sessions.delete(url);
    sid = await session(url);
    out = await post(url, { jsonrpc: '2.0', id, method, params }, sid, timeoutMs);
  }
  if (!out.message) throw new Error('Empty response');
  if (out.message.error) throw new Error(out.message.error.message || 'MCP error');
  return out.message.result;
}

export async function listTools(url) {
  if (toolSchemas.has(url)) return toolSchemas.get(url);
  const result = await rpc(url, 'tools/list', {}, 20_000);
  const map = new Map((result.tools || []).map((t) => [t.name, t]));
  toolSchemas.set(url, map);
  return map;
}

// Calls a tool and returns its structured payload (or parsed text).
export async function callTool(url, name, args, { timeoutMs = 60_000, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await rpc(url, 'tools/call', { name, arguments: args }, timeoutMs);
      const text = result.content?.find((c) => c.type === 'text')?.text;
      if (result.isError) throw new Error(text || `${name} failed`);
      if (result.structuredContent) return result.structuredContent;
      try { return JSON.parse(text); } catch { return text ?? null; }
    } catch (err) {
      const transient = /timed out|timeout|try again|HTTP 5\d\d|fetch failed|aborted/i.test(err.message);
      if (attempt >= retries || !transient) throw err;
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 700));
    }
  }
}

export const caller = (url, opts) => (tool, args) => callTool(url, tool, args, opts);
