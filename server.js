'use strict';
/**
 * CCTV Camera Test & Setup — เซิร์ฟเวอร์ภายในเครื่อง (ฟังที่ 127.0.0.1 เท่านั้น)
 * ใช้ได้ 2 แบบ: node server.js  หรือถูกเรียกจาก Electron (electron/main.js)
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const { Store } = require('./lib/store');
const { StreamManager } = require('./lib/stream');
const { detect } = require('./lib/detect');
const { PtzController } = require('./lib/ptz');
const { scan } = require('./lib/scanner');
const { maskUrl, safeName } = require('./lib/util');

const VERSION = require('./package.json').version;

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) return p; } catch {}
  return 'ffmpeg'; // ใช้ ffmpeg ที่ติดตั้งในเครื่อง (PATH)
}

async function start(options = {}) {
  const ROOT = __dirname;
  const dataDir = options.dataDir || process.env.CCTV_DATA_DIR || path.join(ROOT, 'data');
  const defaultOut = options.outputDir || process.env.CCTV_OUTPUT_DIR || path.join(os.homedir(), 'Documents', 'CCTV');
  const store = new Store(dataDir, { outputDir: defaultOut, transport: 'auto', ptzMode: 'auto' });
  const ffmpegPath = resolveFfmpeg();
  const streams = new StreamManager({ ffmpegPath, tmpDir: path.join(dataDir, 'tmp'), getSettings: () => store.settings });

  const app = express();
  const server = http.createServer(app);
  const wssVideo = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const wssEvents = new WebSocketServer({ noServer: true });

  // ---------------- สถานะ + เหตุการณ์ ----------------
  const state = { phase: 'idle', busy: false, det: null, ptz: null, savedId: null, creds: null, label: '', info: { video: null, audio: null } };
  const history = [];
  const pushEvent = (ev) => {
    const msg = JSON.stringify(ev);
    for (const c of wssEvents.clients) if (c.readyState === 1) c.send(msg);
  };
  const log = (level, msg) => {
    const ev = { type: 'log', level, msg, t: Date.now() };
    history.push(ev); if (history.length > 200) history.shift();
    pushEvent(ev);
  };
  streams.on('log', log);
  streams.on('info', (info) => { state.info = { ...info }; pushEvent({ type: 'stream-info', info: state.info }); });
  streams.on('rec', (r) => pushEvent({ type: 'rec', ...r, name: r.file ? path.basename(r.file) : '' }));
  streams.on('lost', () => { state.phase = 'error'; pushEvent({ type: 'status', phase: 'error' }); });
  streams.on('fatal', () => { state.phase = 'error'; pushEvent({ type: 'status', phase: 'error' }); });
  streams.on('first-data', async () => {
    log('ok', 'เริ่มรับภาพสดจากกล้อง');
    if (state.savedId && state.det) {
      const snap = await streams.waitSnapshot(8000);
      if (snap && state.savedId) {
        try { fs.copyFileSync(snap, store.thumbPath(state.savedId)); store.update(state.savedId, { thumbAt: new Date().toISOString() }); pushEvent({ type: 'cameras' }); } catch {}
      }
    }
  });

  // ---------------- ความปลอดภัยพื้นฐาน ----------------
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const h = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(h)) return res.status(403).end('forbidden');
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(ROOT, 'public')));
  const nm = (p) => path.join(ROOT, 'node_modules', p);
  app.get('/vendor/jsmpeg.js', (_q, r) => r.sendFile(nm('@cycjimmy/jsmpeg-player/dist/jsmpeg-player.umd.min.js')));
  app.use('/fonts', express.static(nm('@fontsource/sarabun/files'), { maxAge: '7d' }));
  app.get('/media/:kind/:name', (req, res) => {
    const sub = req.params.kind === 'snapshot' ? 'Snapshot' : req.params.kind === 'record' ? 'Record' : null;
    if (!sub) return res.status(404).end();
    const f = path.join(store.settings.outputDir, sub, path.basename(req.params.name));
    if (!fs.existsSync(f)) return res.status(404).end();
    res.sendFile(f);
  });

  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); }
  };

  // ---------------- API ----------------
  function summary() {
    const d = state.det;
    if (!d) return null;
    const sdpV = d.sdp && d.sdp.video, sdpA = d.sdp && d.sdp.audio;
    return {
      ip: d.host, label: state.label, kind: d.kind, usedKind: d.usedKind, fallbackFromSub: !!d.fallbackFromSub,
      brand: d.brandLabel, brandKey: d.brandKey, brandVia: d.brandVia, model: d.model, firmware: d.firmware, serial: d.serial,
      rtspPort: d.rtspPort, path: d.path, urlMasked: maskUrl(d.url), foundVia: d.found,
      streams: d.streams, sdp: { video: sdpV && { codec: sdpV.codec, fps: sdpV.fps }, audio: sdpA && { codec: sdpA.codec } },
      ptz: { family: d.ptz.family, onvif: !!d.ptz.onvif, mode: store.settings.ptzMode },
      savedId: state.savedId,
    };
  }

  app.get('/api/state', (_q, res) => res.json({
    version: VERSION, phase: state.phase, session: summary(), info: state.info, settings: store.settings,
    recording: streams.cur && streams.cur.rec ? { startedAt: streams.cur.rec.startedAt, name: path.basename(streams.cur.rec.file) } : null,
    ffmpeg: ffmpegPath, history: history.slice(-60), platform: process.platform,
  }));

  app.post('/api/connect', async (req, res) => {
    if (state.busy) return res.status(409).json({ error: 'กำลังเชื่อมต่ออยู่ กรุณารอสักครู่' });
    state.busy = true; state.phase = 'connecting'; pushEvent({ type: 'status', phase: 'connecting' });
    const b = req.body || {};
    try {
      const saved = b.savedId ? store.get(b.savedId) : null;
      const o = {
        ip: (b.ip || (saved && saved.ip) || '').trim(),
        user: b.user !== undefined && b.user !== '' ? b.user : (saved ? saved.user : ''),
        pass: b.pass ? b.pass : (saved && b.useSavedPass !== false ? saved.pass : ''),
        stream: b.stream === 'sub' ? 'sub' : 'main',
        port: b.port || (saved && saved.port) || '', channel: b.channel || (saved && saved.channel) || 1,
        brand: b.brand || (saved && saved.brand) || 'auto', customUrl: b.customUrl || '',
      };
      if (saved && saved.cache && saved.cache[o.stream]) o.cached = saved.cache[o.stream];
      const label = saved ? saved.name : o.ip;
      log('info', `เริ่มเชื่อมต่อกล้อง ${o.ip} (${o.stream === 'main' ? 'Main' : 'Sub'} Stream)`);
      await streams.stop();
      if (state.ptz) { state.ptz.dispose(); state.ptz = null; }
      state.det = null; state.info = { video: null, audio: null };

      const det = await detect(o, log);
      state.det = det;
      state.label = label;
      state.savedId = saved ? saved.id : null;
      state.creds = { user: o.user, pass: o.pass, stream: o.stream, channel: o.channel, port: o.port, brand: o.brand };
      state.ptz = new PtzController({
        host: det.host, httpPort: det.ptz.httpPort, user: o.user, pass: o.pass, channel: Number(o.channel) || 1,
        family: det.ptz.family, onvif: det.ptz.onvif, mode: store.settings.ptzMode,
      });
      await streams.start(det, label);
      state.phase = 'connected';
      if (saved) {
        store.update(saved.id, { cache: { ...(saved.cache || {}), [det.usedKind]: { path: det.path, port: det.rtspPort, noUserinfo: det.noUserinfo }, }, brand: det.brandKey || saved.brand });
      }
      log('ok', `เชื่อมต่อกล้อง ${o.ip} สำเร็จ`);
      pushEvent({ type: 'status', phase: 'connected' });
      res.json({ ok: true, session: summary() });
    } catch (e) {
      state.phase = 'error'; state.det = null;
      log('err', e.message);
      pushEvent({ type: 'status', phase: 'error', code: e.code });
      res.status(400).json({ error: e.message, code: e.code || 'ERR' });
    } finally { state.busy = false; }
  });

  app.post('/api/disconnect', wrap(async (_q, res) => {
    await streams.stop();
    if (state.ptz) { state.ptz.dispose(); state.ptz = null; }
    state.det = null; state.phase = 'idle'; state.savedId = null; state.info = { video: null, audio: null };
    log('info', 'ตัดการเชื่อมต่อกล้องแล้ว');
    pushEvent({ type: 'status', phase: 'idle' });
    res.json({ ok: true });
  }));

  app.get('/api/session/url', (_q, res) => {
    if (!state.det) return res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อกล้อง' });
    res.json({ url: state.det.url });
  });

  app.post('/api/snapshot', wrap(async (_q, res) => {
    try {
      const r = streams.snapshot();
      log('ok', `บันทึกภาพไปที่: ${r.file}`);
      res.json({ ok: true, file: r.file, name: path.basename(r.file) });
    } catch (e) { log('err', e.message); res.status(400).json({ error: e.message }); }
  }));
  app.post('/api/record/start', wrap(async (_q, res) => {
    try { const r = streams.startRecord(); log('ok', `เริ่มบันทึกวิดีโอไปที่: ${path.dirname(r.file)}`); res.json({ ok: true, file: r.file }); }
    catch (e) { log('err', e.message); res.status(400).json({ error: e.message }); }
  }));
  app.post('/api/record/stop', wrap(async (_q, res) => {
    try {
      const r = await streams.stopRecord();
      log('ok', `หยุดบันทึก (${r.seconds} วินาที, ${(r.size / 1048576).toFixed(1)} MB): ${r.file}`);
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  }));

  // ---- PTZ ----
  app.post('/api/ptz', wrap(async (req, res) => {
    const p = state.ptz;
    if (!p) return res.status(400).json({ ok: false, error: 'ยังไม่ได้เชื่อมต่อกล้อง' });
    p.mode = store.settings.ptzMode;
    const b = req.body || {};
    let r;
    switch (b.cmd) {
      case 'move': r = await p.move(b.dir, b.speed); break;
      case 'lens': r = await p.lens(b.kind, Number(b.dir), b.speed); break;
      case 'stop': r = await p.stop(b.what || 'all'); break;
      case 'goto': r = await p.gotoPreset(Number(b.id) || b.id); break;
      case 'setpreset': r = await p.setPreset(Number(b.id) || b.id, b.name); break;
      case 'tour': r = b.action === 'stop' ? await p.tourStop(Number(b.n) || 1) : await p.tourStart(Number(b.n) || 1); break;
      default: return res.status(400).json({ ok: false, error: 'คำสั่งไม่ถูกต้อง' });
    }
    if (!r.ok && b.cmd !== 'stop') log('warn', `คำสั่ง PTZ ไม่สำเร็จ: ${r.error}`);
    res.json(r);
  }));
  app.get('/api/ptz/presets', wrap(async (_q, res) => {
    if (!state.ptz) return res.status(400).json({ ok: false, error: 'ยังไม่ได้เชื่อมต่อกล้อง' });
    state.ptz.mode = store.settings.ptzMode;
    res.json(await state.ptz.getPresets());
  }));

  // ---- รายการกล้อง ----
  app.get('/api/cameras', (_q, res) => res.json(store.list()));
  app.post('/api/cameras', wrap(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'กรุณาตั้งชื่อกล้อง' });
    if (store.data.cameras.length >= 200) return res.status(400).json({ error: 'รายการกล้องเต็ม (200 ตัว)' });
    let rec;
    if (b.fromSession && state.det && state.creds) {
      const d = state.det, c = state.creds;
      rec = { name, ip: d.host, user: c.user, pass: c.pass, stream: c.stream, channel: c.channel, port: c.port || '', brand: d.brandKey || 'auto',
        cache: { [d.usedKind]: { path: d.path, port: d.rtspPort, noUserinfo: d.noUserinfo } } };
    } else {
      if (!b.ip) return res.status(400).json({ error: 'กรุณาใส่ IP' });
      rec = { name, ip: String(b.ip).trim(), user: b.user || '', pass: b.pass || '', stream: b.stream === 'sub' ? 'sub' : 'main', channel: b.channel || 1, port: b.port || '', brand: b.brand || 'auto' };
    }
    const cam = store.add(rec);
    if (b.fromSession && state.det) {
      state.savedId = cam.id; state.label = name; if (streams.cur) streams.cur.label = name;
      try {
        const f = streams.cur && streams.cur.snapFile;
        if (f && fs.existsSync(f)) { fs.copyFileSync(f, store.thumbPath(cam.id)); store.update(cam.id, { thumbAt: new Date().toISOString() }); }
      } catch {}
    }
    log('ok', `เพิ่มกล้อง "${name}" (${cam.ip}) ในรายการแล้ว`);
    res.json({ ok: true, id: cam.id, cameras: store.list() });
  }));
  app.put('/api/cameras/:id', wrap(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.name) patch.name = String(b.name).trim();
    const c = store.update(req.params.id, patch);
    if (!c) return res.status(404).json({ error: 'ไม่พบกล้อง' });
    res.json({ ok: true, cameras: store.list() });
  }));
  app.delete('/api/cameras/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!store.remove(id)) return res.status(404).json({ error: 'ไม่พบกล้อง' });
    if (state.savedId === id) state.savedId = null;
    res.json({ ok: true, cameras: store.list() });
  }));
  app.get('/api/cameras/:id/thumb', (req, res) => {
    const f = store.thumbPath(req.params.id);
    if (!fs.existsSync(f)) return res.status(404).end();
    res.set('Cache-Control', 'no-cache').sendFile(f);
  });

  // ---- ไฟล์ที่บันทึก ----
  app.get('/api/files', wrap(async (_q, res) => {
    const out = [];
    for (const [kind, sub] of [['snapshot', 'Snapshot'], ['record', 'Record']]) {
      const dir = path.join(store.settings.outputDir, sub);
      let names = []; try { names = fs.readdirSync(dir); } catch {}
      for (const n of names) {
        if (!/\.(jpg|jpeg|png|mp4|mkv)$/i.test(n)) continue;
        try { const st = fs.statSync(path.join(dir, n)); out.push({ kind, name: n, size: st.size, mtime: st.mtimeMs, url: `/media/${kind}/${encodeURIComponent(n)}` }); } catch {}
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    res.json({ dir: store.settings.outputDir, files: out.slice(0, 120) });
  }));
  app.post('/api/open', wrap(async (req, res) => {
    const b = req.body || {};
    const sub = b.kind === 'record' ? 'Record' : 'Snapshot';
    const dir = path.join(store.settings.outputDir, sub);
    fs.mkdirSync(dir, { recursive: true });
    const target = b.name ? path.join(dir, path.basename(b.name)) : dir;
    if (b.name && !fs.existsSync(target)) return res.status(404).json({ error: 'ไม่พบไฟล์' });
    const cmd = process.platform === 'win32' ? ['explorer.exe', [target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
    const p = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
    p.on('error', () => {}); p.unref();
    res.json({ ok: true, path: target });
  }));

  // ---- ตั้งค่า ----
  app.get('/api/settings', (_q, res) => res.json(store.settings));
  app.post('/api/settings', wrap(async (req, res) => {
    const b = req.body || {}, patch = {};
    if (b.outputDir) {
      const d = path.resolve(String(b.outputDir));
      try { fs.mkdirSync(path.join(d, 'Snapshot'), { recursive: true }); fs.mkdirSync(path.join(d, 'Record'), { recursive: true }); }
      catch (e) { return res.status(400).json({ error: `สร้างโฟลเดอร์ไม่ได้: ${e.message}` }); }
      patch.outputDir = d;
    }
    if (['auto', 'tcp', 'udp'].includes(b.transport)) patch.transport = b.transport;
    if (['auto', 'onvif', 'dahua', 'hikvision'].includes(b.ptzMode)) patch.ptzMode = b.ptzMode;
    res.json({ ok: true, settings: store.setSettings(patch) });
  }));

  // ---- สแกนหากล้องในวงแลน ----
  let scanning = false;
  app.post('/api/scan', async (_q, res) => {
    if (scanning) return res.status(409).json({ error: 'กำลังสแกนอยู่' });
    scanning = true;
    log('info', 'เริ่มสแกนหากล้องในเครือข่าย ...');
    try {
      const list = await scan((ev) => pushEvent({ type: 'scan', kind: ev.type, device: ev.device, done: ev.done, total: ev.total }));
      log('ok', `สแกนเสร็จ พบอุปกรณ์ที่น่าจะเป็นกล้อง ${list.length} เครื่อง`);
      pushEvent({ type: 'scan', kind: 'done' });
      res.json({ ok: true, devices: list });
    } catch (e) { log('err', e.message); res.status(400).json({ error: e.message }); }
    finally { scanning = false; }
  });

  // ---------------- WebSocket ----------------
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(req.headers.host || ''));
    const originOk = !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin) || origin === 'null';
    if (!hostOk || !originOk) { socket.destroy(); return; }
    const url = (req.url || '').split('?')[0];
    if (url === '/ws/video') wssVideo.handleUpgrade(req, socket, head, (ws) => streams.attach(ws));
    else if (url === '/ws/events') wssEvents.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ type: 'hello', version: VERSION })));
    else socket.destroy();
  });

  // ---------------- เริ่มฟังพอร์ต ----------------
  const wanted = options.port !== undefined ? options.port : Number(process.env.PORT || 3000);
  const listenOn = (port) => new Promise((resolve, reject) => {
    const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(server.address().port); };
    server.once('error', onErr); server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
  let port;
  for (let i = 0; i < 12; i++) {
    try { port = await listenOn(wanted === 0 ? 0 : wanted + i); break; }
    catch (e) { if (e.code !== 'EADDRINUSE' || i === 11) throw e; }
  }
  const stop = async () => { try { await streams.stop(); } catch {} try { server.close(); } catch {} };
  return { port, stop, store, ffmpegPath };
}

module.exports = { start };

if (require.main === module) {
  start().then(({ port, ffmpegPath }) => {
    console.log(`CCTV Camera Test & Setup พร้อมใช้งานที่ http://127.0.0.1:${port}`);
    console.log(`ffmpeg: ${ffmpegPath}`);
    if (process.env.CCTV_NO_BROWSER !== '1' && process.platform === 'win32') spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${port}`], { detached: true, stdio: 'ignore' }).unref();
  }).catch((e) => { console.error('เริ่มเซิร์ฟเวอร์ไม่ได้:', e.message); process.exit(1); });
  const bye = () => process.exit(0);
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
