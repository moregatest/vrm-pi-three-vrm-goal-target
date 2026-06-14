// VRM API / event bridge.
//   POST /vrm/say        {text}
//   POST /vrm/expression {emotion}
//   POST /vrm/motion     {motion}
//   POST /vrm/reset      {}
//   GET  /vrm/events     -> Server-Sent Events stream (forwarded to the browser)
//   GET  /vrm/health
// Every accepted call is appended to a JSONL event log AND broadcast over SSE,
// so the browser runtime reacts immediately (not log-only).
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AVATARS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'avatars');

const PORT = Number(process.env.VRM_API_PORT || 8970);
const LOG = process.env.VRM_EVENT_LOG || path.join(process.cwd(), 'events.jsonl');

const app = express();
app.use(cors());
app.use(express.json());

/** @type {Set<import('http').ServerResponse>} */
const clients = new Set();
let seq = 0;

function append(ev) {
  fs.appendFileSync(LOG, JSON.stringify(ev) + '\n');
}
function broadcast(ev) {
  const frame = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { /* client gone */ }
  }
}
function record(type, fields) {
  const ev = { ts: Date.now(), seq: ++seq, type, ...fields };
  append(ev);
  broadcast(ev);
  console.log('[vrm-api] event', JSON.stringify(ev));
  return ev;
}

app.post('/vrm/say', (req, res) => {
  const ev = record('say', { text: String((req.body && req.body.text) ?? '') });
  res.json({ ok: true, event: ev });
});
app.post('/vrm/expression', (req, res) => {
  const ev = record('expression', { emotion: String((req.body && req.body.emotion) ?? '') });
  res.json({ ok: true, event: ev });
});
app.post('/vrm/motion', (req, res) => {
  const ev = record('motion', { motion: String((req.body && req.body.motion) ?? '') });
  res.json({ ok: true, event: ev });
});
app.post('/vrm/reset', (req, res) => {
  const ev = record('reset', {});
  res.json({ ok: true, event: ev });
});
app.post('/vrm/load', (req, res) => {
  const b = req.body || {};
  const url = b.url || (b.name ? `/avatars/${b.name}` : '');
  const ev = record('load', { url });
  res.json({ ok: true, event: ev });
});
app.get('/vrm/avatars', (req, res) => {
  let names = [];
  try { names = fs.readdirSync(AVATARS_DIR).filter((n) => n.toLowerCase().endsWith('.vrm')).sort(); } catch {}
  res.json(names);
});

app.get('/vrm/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  res.write(`: connected ${Date.now()}\n\n`);
  clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

app.get('/vrm/health', (req, res) => {
  res.json({ ok: true, clients: clients.size, log: LOG, events: seq });
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[vrm-api] listening on http://127.0.0.1:${PORT}  log=${LOG}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
