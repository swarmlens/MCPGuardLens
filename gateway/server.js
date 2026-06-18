/**
 * MCPGuard Gateway — JSON-RPC 2.0 edition
 * Supports streamableHttp MCP servers (initialize handshake + session IDs)
 */

const express = require('express');
const http    = require('http');
const https   = require('https');

const app  = express();
const PORT = 8080;

const UPSTREAM    = (process.env.UPSTREAM_MCP || 'http://mcp-everything:3000').replace(/\/$/, '');
const CH_URL      = process.env.CLICKHOUSE_URL     || 'http://clickhouse:8123';
const CH_USER     = process.env.CLICKHOUSE_USER    || 'mcpguard';
const CH_PASS     = process.env.CLICKHOUSE_PASSWORD || '';
const RATE_MAX    = parseInt(process.env.RATE_LIMIT_MAX    || '30');
const RATE_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || '30') * 1000;
const BLOCK_PATS  = (process.env.BLOCK_PATTERNS || 'rm -rf,DROP TABLE,/etc/passwd,/etc/shadow,../')
                      .split(',').map(p => p.trim().toLowerCase());
const API_KEY     = process.env.GATEWAY_API_KEY || '';

app.use(express.json({ limit: '2mb' }));

// ── Session store ────────────────────────────────────────────────
const sessions = new Map(); // agentId → sessionId string

// ── Rate limiter ─────────────────────────────────────────────────
const rateLimitStore = new Map();

function checkRateLimit(agentId) {
  const now = Date.now();
  const rec = rateLimitStore.get(agentId) || { count: 0, window_start: now };
  if (now - rec.window_start > RATE_WINDOW) { rec.count = 0; rec.window_start = now; }
  rec.count++;
  rateLimitStore.set(agentId, rec);
  return { allowed: rec.count <= RATE_MAX, count: rec.count };
}

// ── Inject scorer ────────────────────────────────────────────────
const INJECT_PATTERNS = [
  /ignore.{0,30}previous.{0,30}instructions/i,
  /<system>/i,
  /act as.{0,30}root/i,
  /forget.{0,20}instructions/i,
  /you are now/i,
  /maintenance mode/i,
  /bypass.{0,20}security/i,
  /exfil/i,
  /\bsudo\b/i,
];

function injectScore(obj) {
  const str = JSON.stringify(obj || '');
  let hits = 0;
  for (const pat of INJECT_PATTERNS) if (pat.test(str)) hits++;
  return parseFloat((hits / INJECT_PATTERNS.length).toFixed(2));
}

// ── Dangerous payload check ──────────────────────────────────────
function dangerousPattern(obj) {
  const flat = JSON.stringify(obj || '').toLowerCase();
  for (const pat of BLOCK_PATS) if (flat.includes(pat)) return pat;
  return null;
}

// ── ClickHouse logger ────────────────────────────────────────────
function logToClickHouse(row) {
  const sql = `INSERT INTO mcpguard.tool_calls `
    + `(agent_id,tool,verdict,latency_ms,inject_score,block_reason,params_hash) VALUES (`
    + `'${esc(row.agent_id)}','${esc(row.tool)}','${esc(row.verdict)}',`
    + `${row.latency_ms||0},${row.inject_score||0},'${esc(row.block_reason||'')}',`
    + `'${simpleHash(JSON.stringify(row.params||{}))}')`;

  const isHttps = CH_URL.startsWith('https');
  const url = new URL(`${CH_URL}/?query=${encodeURIComponent(sql)}`);
  const lib = isHttps ? https : http;
  const req = lib.request({
    hostname: url.hostname, port: url.port||(isHttps?443:80),
    path: url.pathname+url.search, method: 'POST',
    headers: { 'X-ClickHouse-User': CH_USER, 'X-ClickHouse-Key': CH_PASS }
  }, ()=>{});
  req.on('error', e => console.error('[CH]', e.message));
  req.end();
}

function esc(s) { return String(s||'').replace(/'/g,"''").slice(0,500); }
function simpleHash(s) {
  let h=0; for (const c of s) h=(Math.imul(31,h)+c.charCodeAt(0))|0;
  return Math.abs(h).toString(16);
}

// ── Forward JSON-RPC to upstream ─────────────────────────────────
function forwardJsonRpc(body, sessionId, cb) {
  const isHttps = UPSTREAM.startsWith('https');
  const upUrl   = new URL(`${UPSTREAM}/mcp`);
  const data    = JSON.stringify(body);
  const start   = Date.now();
  const lib     = isHttps ? https : http;

  const headers = {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Accept':         'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const req = lib.request({
    hostname: upUrl.hostname,
    port:     upUrl.port || (isHttps ? 443 : 80),
    path:     upUrl.pathname,
    method:   'POST',
    headers
  }, res => {
    let raw = '';
    res.on('data', d => raw += d);
    res.on('end', () => {
      const newSession = res.headers['mcp-session-id'] || sessionId;
      try {
        const text = raw.trim();
        let parsed;
        // SSE: skip event:/id: lines, find the data: line
        if (text.includes('data:')) {
          const dataLine = text.split('\n').find(l => l.trimStart().startsWith('data:'));
          if (!dataLine) throw new Error('No data line in SSE response');
          parsed = JSON.parse(dataLine.replace(/^data:\s*/, '').trim());
        } else {
          parsed = JSON.parse(text);
        }
        cb(null, parsed, Date.now()-start, res.statusCode, newSession);
      } catch(e) {
        cb(new Error(`upstream parse error: ${e.message} body: ${raw.slice(0,300)}`));
      }
    });
  });
  req.on('error', cb);
  req.write(data);
  req.end();
}

// ── MCP initialize handshake ─────────────────────────────────────
function initSession(agentId, cb) {
  console.log(`[session] initializing for agent ${agentId}`);
  forwardJsonRpc({
    jsonrpc: '2.0', id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcpguard', version: '1.0.0' }
    }
  }, null, (err, result, latency, statusCode, sessionId) => {
    if (err) return cb(err);
    console.log(`[session] got session ${sessionId} for agent ${agentId}`);
    sessions.set(agentId, sessionId);

    // send initialized notification (fire and forget)
    forwardJsonRpc({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    }, sessionId, () => cb(null, sessionId));
  });
}

function getSession(agentId, cb) {
  if (sessions.has(agentId)) return cb(null, sessions.get(agentId));
  initSession(agentId, cb);
}

// ── API key middleware ────────────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-mcpguard-key'] !== API_KEY)
    return res.status(401).json({ error: 'Invalid or missing X-MCPGuard-Key' });
  next();
}

// ── Security checks (shared) ─────────────────────────────────────
function runGuards(agentId, toolName, params, role) {
  const rl = checkRateLimit(agentId);
  if (!rl.allowed) return { blocked: true, status: 429, reason: 'rate_limit',
    message: `${rl.count} calls exceeded ${RATE_MAX}/${RATE_WINDOW/1000}s` };

  const danger = dangerousPattern(params);
  if (danger) return { blocked: true, status: 400, reason: 'dangerous_payload',
    message: `Blocked: "${danger}"` };

  if (toolName && toolName.startsWith('admin') && role !== 'admin')
    return { blocked: true, status: 403, reason: 'rbac_violation',
      message: `${toolName} requires role=admin` };

  const score = injectScore(params);
  if (score >= 0.8) return { blocked: true, status: 400, reason: 'prompt_injection',
    message: `Inject score ${score} >= 0.8`, score };

  return { blocked: false, score };
}

// ═══════════════════════════════════════════════════════
// ROUTE 1: Native JSON-RPC — real MCP clients use this
// POST /mcp
// ═══════════════════════════════════════════════════════
app.post('/mcp', requireApiKey, (req, res) => {
  const body     = req.body;
  const method   = body.method || '';
  const agentId  = req.headers['x-agent-id'] || 'unknown';
  const toolName = method === 'tools/call' ? (body.params?.name || '') : method;
  const params   = body.params || {};
  const role     = req.headers['x-agent-role'];

  // allow initialize and notifications through without guards
  if (method === 'initialize' || method.startsWith('notifications/')) {
    return getSession(agentId, (err, sessionId) => {
      if (err) return res.status(502).json({ jsonrpc:'2.0', id:body.id,
        error:{ code:-32000, message: err.message }});
      forwardJsonRpc(body, sessionId, (err2, result, latency, status, newSession) => {
        if (err2) return res.status(502).json({ jsonrpc:'2.0', id:body.id,
          error:{ code:-32000, message: err2.message }});
        if (newSession) sessions.set(agentId, newSession);
        res.status(status||200).json(result);
      });
    });
  }

  const guard = runGuards(agentId, toolName, params, role);
  if (guard.blocked) {
    logToClickHouse({ agent_id:agentId, tool:toolName, verdict:'block',
      block_reason:guard.reason, inject_score:guard.score||0, latency_ms:0, params });
    return res.status(guard.status).json({ jsonrpc:'2.0', id:body.id,
      error:{ code:-32000, message:guard.message }});
  }

  getSession(agentId, (err, sessionId) => {
    if (err) return res.status(502).json({ jsonrpc:'2.0', id:body.id,
      error:{ code:-32000, message:err.message }});

    forwardJsonRpc(body, sessionId, (err2, result, latency, status, newSession) => {
      if (err2) {
        logToClickHouse({ agent_id:agentId, tool:toolName, verdict:'error',
          block_reason:err2.message, inject_score:guard.score, latency_ms:0 });
        return res.status(502).json({ jsonrpc:'2.0', id:body.id,
          error:{ code:-32000, message:err2.message }});
      }
      if (newSession) sessions.set(agentId, newSession);
      const verdict = guard.score > 0.4 ? 'review' : 'allow';
      logToClickHouse({ agent_id:agentId, tool:toolName, verdict,
        inject_score:guard.score, latency_ms:latency, params });
      res.status(status||200).json({ ...result,
        _gateway:{ verdict, inject_score:guard.score, latency_ms:latency }});
    });
  });
});

// ═══════════════════════════════════════════════════════
// ROUTE 2: REST shim — GET /tools/list
// ═══════════════════════════════════════════════════════
app.get('/tools/list', requireApiKey, (req, res) => {
  const agentId = req.headers['x-agent-id'] || 'list-client';
  getSession(agentId, (err, sessionId) => {
    if (err) return res.status(502).json({ error: err.message });
    forwardJsonRpc({ jsonrpc:'2.0', id:2, method:'tools/list', params:{} },
      sessionId, (err2, result, latency, status, newSession) => {
        if (err2) return res.status(502).json({ error: err2.message });
        if (newSession) sessions.set(agentId, newSession);
        res.json(result?.result || result);
    });
  });
});

// ═══════════════════════════════════════════════════════
// ROUTE 3: REST shim — POST /tools/call
// ═══════════════════════════════════════════════════════
app.post('/tools/call', requireApiKey, (req, res) => {
  const { tool, parameters, agent_id='unknown' } = req.body;
  const role  = req.headers['x-agent-role'];
  const guard = runGuards(agent_id, tool, parameters, role);

  if (guard.blocked) {
    logToClickHouse({ agent_id, tool, verdict:'block',
      block_reason:guard.reason, inject_score:guard.score||0, latency_ms:0, params:parameters });
    return res.status(guard.status).json({ blocked:true, reason:guard.reason,
      message:guard.message, score:guard.score });
  }

  getSession(agent_id, (err, sessionId) => {
    if (err) return res.status(502).json({ error: err.message });
    forwardJsonRpc({
      jsonrpc:'2.0', id:1, method:'tools/call',
      params:{ name:tool, arguments:parameters||{} }
    }, sessionId, (err2, result, latency, status, newSession) => {
      if (err2) return res.status(502).json({ error: err2.message });
      if (newSession) sessions.set(agent_id, newSession);
      const verdict = guard.score > 0.4 ? 'review' : 'allow';
      logToClickHouse({ agent_id, tool, verdict,
        inject_score:guard.score, latency_ms:latency, params:parameters });
      res.json({ ...(result?.result||result),
        _gateway:{ verdict, inject_score:guard.score, latency_ms:latency }});
    });
  });
});

// ── Stats & health ───────────────────────────────────────────────
app.get('/stats', (req, res) => {
  const rl = {};
  rateLimitStore.forEach((v,k) => { rl[k]=v.count; });
  res.json({ uptime_s:Math.round(process.uptime()), upstream:UPSTREAM,
             sessions:sessions.size, rate_limit_counters:rl });
});

app.get('/health', (req, res) => res.json({ status:'ok', upstream:UPSTREAM }));

app.listen(PORT, () => {
  console.log(`MCPGuard gateway :${PORT} → ${UPSTREAM}`);
  console.log(`Rate limit: ${RATE_MAX} calls/${RATE_WINDOW/1000}s`);
  console.log(`API key auth: ${API_KEY ? 'enabled' : 'disabled'}`);
});
