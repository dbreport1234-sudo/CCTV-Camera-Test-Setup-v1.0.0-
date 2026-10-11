'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { stamp, safeName, maskUrl, sleep } = require('./util');

const VCODEC = { h264: 'H.264', hevc: 'H.265', mjpeg: 'MJPEG', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', vp8: 'VP8' };
const ACODEC = { pcm_alaw: 'G.711 A-law', pcm_mulaw: 'G.711 µ-law', aac: 'AAC', mp3: 'MP3', opus: 'Opus', adpcm_g726: 'G.726', pcm_s16be: 'PCM', pcm_s16le: 'PCM' };

function parseStreamLine(line) {
  const clean = line.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '');
  let m = clean.match(/Video:\s*([\w]+)/);
  if (m) {
    const res = clean.match(/(\d{2,5})x(\d{2,5})/);
    const fps = clean.match(/(\d+(?:\.\d+)?)\s*fps/) || clean.match(/(\d+(?:\.\d+)?)\s*tbr/);
    return { video: { codec: VCODEC[m[1]] || m[1], raw: m[1], width: res ? +res[1] : 0, height: res ? +res[2] : 0, fps: fps ? Math.round(parseFloat(fps[1]) * 10) / 10 : 0 } };
  }
  m = clean.match(/Audio:\s*([\w]+)/);
  if (m) {
    const hz = clean.match(/(\d+)\s*Hz/);
    return { audio: { codec: ACODEC[m[1]] || m[1], raw: m[1], rate: hz ? +hz[1] : 0, channels: /stereo/.test(clean) ? 2 : 1 } };
  }
  return null;
}

function explainError(line) {
  if (/401 Unauthorized|Unauthorized|403 Forbidden/i.test(line)) return 'กล้องปฏิเสธรหัสผ่านตอนเปิดสตรีม';
  if (/Connection refused/i.test(line)) return 'กล้องปฏิเสธการเชื่อมต่อ RTSP (อาจมีผู้ดูเต็มจำนวนหรือ RTSP ถูกปิด)';
  if (/timed out|timeout/i.test(line)) return 'การเชื่อมต่อกล้องหมดเวลา';
  if (/453 Not Enough Bandwidth|Not enough bandwidth/i.test(line)) return 'กล้องแจ้งว่าแบนด์วิดท์/จำนวนผู้ดูเต็ม (ลองปิดโปรแกรมอื่นที่ดูกล้องนี้อยู่)';
  if (/Invalid data found|Could not find codec parameters|no frame/i.test(line)) return 'อ่านข้อมูลภาพจากกล้องไม่ได้ (สตรีมอาจผิดรูปแบบ)';
  return null;
}

class StreamManager extends EventEmitter {
  constructor({ ffmpegPath, tmpDir, getSettings }) {
    super();
    this.ffmpeg = ffmpegPath;
    this.tmpDir = tmpDir;
    this.getSettings = getSettings;
    this.cur = null;
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  log(level, msg) { this.emit('log', level, msg); }

  /** เริ่ม session ใหม่ (ปิดของเดิมก่อน) — ffmpeg จะเริ่มทำงานเมื่อมีหน้าจอมาต่อ websocket */
  async start(det, label) {
    await this.stop();
    const id = Date.now().toString(36);
    this.cur = {
      id, det, label: label || det.host, clients: new Set(), proc: null, stopped: false,
      snapFile: path.join(this.tmpDir, `snap-${id}.jpg`), info: { video: null, audio: null },
      restarts: 0, gotData: false, idleTimer: null, transportTry: 0, rec: null,
    };
    this.emit('session', this.cur);
    return this.cur;
  }

  async stop() {
    const c = this.cur;
    if (!c) return;
    c.stopped = true;
    clearTimeout(c.idleTimer);
    if (c.rec) await this.stopRecord().catch(() => {});
    this.killProc(c);
    for (const ws of c.clients) { try { ws.close(1000, 'stopped'); } catch {} }
    try { fs.unlinkSync(c.snapFile); } catch {}
    this.cur = null;
    this.emit('session', null);
  }

  killProc(c) {
    if (c.proc) { try { c.proc.kill('SIGKILL'); } catch {} c.proc = null; }
  }

  attach(ws) {
    const c = this.cur;
    if (!c) { ws.close(1008, 'no session'); return; }
    c.clients.add(ws);
    clearTimeout(c.idleTimer);
    ws.on('close', () => {
      c.clients.delete(ws);
      if (!c.clients.size && !c.stopped) {
        c.idleTimer = setTimeout(() => { if (!c.clients.size) { this.killProc(c); } }, 4000);
      }
    });
    if (!c.proc) this.spawnLive(c);
  }

  transport(c) {
    const t = (this.getSettings().transport || 'auto');
    if (t === 'tcp' || t === 'udp') return t;
    return c.transportTry % 2 === 0 ? 'tcp' : 'udp';
  }

  spawnLive(c) {
    const kind = c.det.usedKind || c.det.kind;
    const maxW = kind === 'sub' ? 960 : 1280;
    const vb = kind === 'sub' ? '1500k' : '3500k';
    const tr = this.transport(c);
    const args = [
      '-hide_banner', '-loglevel', 'info', '-nostats',
      '-rtsp_transport', tr, '-timeout', '10000000',
      '-fflags', 'nobuffer+discardcorrupt', '-flags', 'low_delay',
      '-analyzeduration', '1500000', '-probesize', '1500000',
      '-i', c.det.url,
      '-filter_complex',
      `[0:v:0]split=2[a][b];[a]fps=25,scale='trunc(min(${maxW},iw)/2)*2':-2:flags=fast_bilinear,format=yuv420p[live];[b]fps=1,format=yuvj420p[snap]`,
      '-map', '[live]', '-map', '0:a:0?',
      '-c:v', 'mpeg1video', '-b:v', vb, '-maxrate', vb, '-bufsize', '1200k', '-bf', '0', '-g', '25',
      '-c:a', 'mp2', '-ar', '44100', '-ac', '1', '-b:a', '96k',
      '-f', 'mpegts', '-muxdelay', '0.001', '-flush_packets', '1', 'pipe:1',
      '-map', '[snap]', '-q:v', '3', '-update', '1', '-atomic_writing', '1', '-f', 'image2', '-y', c.snapFile,
    ];
    this.log('info', `เริ่มเปิดสตรีม (${tr.toUpperCase()}) ...`);
    const p = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    c.proc = p;
    c.gotData = false;
    let section = '';
    let errBuf = '';
    let lastErrLog = 0;
    const firstTimer = setTimeout(() => {
      if (!c.gotData && c.proc === p) this.log('warn', 'ยังไม่ได้รับภาพจากกล้องภายใน 15 วินาที — กล้องอาจตอบช้าหรือรูปแบบสตรีมไม่รองรับ');
    }, 15000);

    p.stdout.on('data', (chunk) => {
      if (!c.gotData) {
        c.gotData = true;
        c.gotDataAt = Date.now();
        this.emit('first-data', c);
      }
      for (const ws of c.clients) {
        if (ws.readyState === 1) {
          if (ws.bufferedAmount > 8 * 1024 * 1024) continue; // หน้าจอรับไม่ทัน ข้ามเฟรม
          ws.send(chunk, { binary: true });
        }
      }
    });
    p.stderr.on('data', (d) => {
      errBuf += d.toString('utf8');
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, i).replace(/\r$/, ''); errBuf = errBuf.slice(i + 1);
        if (/^Input #0/.test(line)) section = 'in';
        else if (/^Output #/.test(line)) section = 'out';
        if (section === 'in' && /Stream #\d+:\d+/.test(line)) {
          const r = parseStreamLine(line);
          if (r) { Object.assign(c.info, r); this.emit('info', c.info); }
        }
        const ex = explainError(line);
        if (ex && Date.now() - lastErrLog > 4000) { lastErrLog = Date.now(); this.log('err', ex); }
      }
    });
    p.on('error', (e) => { this.log('err', `เปิด ffmpeg ไม่ได้: ${e.message}`); this.emit('fatal', e); });
    p.on('exit', async (code) => {
      clearTimeout(firstTimer);
      if (c.proc === p) c.proc = null; else return;
      if (c.stopped) return;
      if (!c.clients.size) return;     // ไม่มีคนดูแล้ว ไม่ต้องเริ่มใหม่
      const hadData = c.gotData && Date.now() - c.gotDataAt > 8000;
      if (hadData) c.restarts = 0; else c.restarts++;
      if (!c.gotData) c.transportTry++;
      if (c.restarts > 4) {
        this.log('err', 'สตรีมขาดและเชื่อมต่อใหม่ไม่สำเร็จ — กด "เชื่อมต่อกล้อง" อีกครั้ง');
        this.emit('lost', c);
        return;
      }
      this.log('warn', `สตรีมหยุด (code ${code}) กำลังเชื่อมต่อใหม่ครั้งที่ ${c.restarts || 1} ...`);
      await sleep(1500);
      if (!c.stopped && c.clients.size && !c.proc) this.spawnLive(c);
    });
  }

  // ---------- Snapshot ----------
  snapshot() {
    const c = this.cur;
    if (!c) throw new Error('ยังไม่ได้เชื่อมต่อกล้อง');
    let st;
    try { st = fs.statSync(c.snapFile); } catch { throw new Error('ยังไม่มีภาพจากกล้อง กรุณารอสักครู่แล้วลองใหม่'); }
    if (Date.now() - st.mtimeMs > 15000) throw new Error('ภาพล่าสุดจากกล้องเก่าเกินไป (สตรีมอาจหยุดอยู่)');
    const dir = path.join(this.getSettings().outputDir, 'Snapshot');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safeName(c.label)}_${stamp()}.jpg`);
    fs.copyFileSync(c.snapFile, file);
    return { file, size: fs.statSync(file).size };
  }
  /** อ่านภาพล่าสุดไว้ทำภาพตัวอย่าง (thumbnail) */
  async waitSnapshot(timeoutMs = 8000) {
    const c = this.cur; if (!c) return null;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs && this.cur === c) {
      try { if (Date.now() - fs.statSync(c.snapFile).mtimeMs < 10000) return c.snapFile; } catch {}
      await sleep(400);
    }
    return null;
  }

  // ---------- Record ----------
  startRecord() {
    const c = this.cur;
    if (!c) throw new Error('ยังไม่ได้เชื่อมต่อกล้อง');
    if (c.rec) throw new Error('กำลังบันทึกอยู่แล้ว');
    const vraw = c.info.video && c.info.video.raw;
    const ext = vraw === 'mjpeg' || vraw === 'mpeg4' ? 'mkv' : 'mp4';
    const dir = path.join(this.getSettings().outputDir, 'Record');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safeName(c.label)}_${stamp()}.${ext}`);
    const args = ['-hide_banner', '-loglevel', 'warning', '-rtsp_transport', this.transport(c) === 'udp' ? 'udp' : 'tcp', '-timeout', '10000000',
      '-i', c.det.url, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy'];
    if (vraw === 'hevc' && ext === 'mp4') args.push('-tag:v', 'hvc1');
    args.push('-c:a', ext === 'mp4' ? 'aac' : 'copy');
    if (ext === 'mp4') args.push('-b:a', '64k', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4');
    args.push('-y', file);
    const p = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    const rec = { proc: p, file, startedAt: Date.now() };
    let errTxt = '';
    p.stderr.on('data', (d) => { errTxt += d.toString(); if (errTxt.length > 4000) errTxt = errTxt.slice(-2000); });
    p.on('error', (e) => { this.log('err', `เริ่มบันทึกไม่ได้: ${e.message}`); });
    p.on('exit', (code) => {
      if (c.rec === rec) {
        c.rec = null;
        this.log('err', `การบันทึกหยุดเอง (code ${code}) ${explainError(errTxt) || ''}`.trim());
        this.emit('rec', { recording: false, file });
      }
    });
    c.rec = rec;
    this.emit('rec', { recording: true, file, startedAt: rec.startedAt });
    return { file };
  }

  async stopRecord() {
    const c = this.cur;
    if (!c || !c.rec) throw new Error('ไม่ได้กำลังบันทึกอยู่');
    const rec = c.rec; c.rec = null;
    const exited = new Promise((r) => rec.proc.once('exit', r));
    try { rec.proc.stdin.write('q'); rec.proc.stdin.end(); } catch {}
    await Promise.race([exited, sleep(5000)]);
    try { rec.proc.kill('SIGKILL'); } catch {}
    let size = 0; try { size = fs.statSync(rec.file).size; } catch {}
    const seconds = Math.round((Date.now() - rec.startedAt) / 1000);
    this.emit('rec', { recording: false, file: rec.file });
    return { file: rec.file, size, seconds };
  }
}

module.exports = { StreamManager, maskUrl };
