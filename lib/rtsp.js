'use strict';
const net = require('net');
const { parseChallenges, buildAuthorization } = require('./digest');

const VIDEO_NAMES = { H264: 'H.264', H265: 'H.265', HEVC: 'H.265', JPEG: 'MJPEG', 'MP4V-ES': 'MPEG-4', 'X-H264': 'H.264' };
const AUDIO_NAMES = { PCMA: 'G.711 A-law', PCMU: 'G.711 µ-law', 'MPEG4-GENERIC': 'AAC', AAC: 'AAC', L16: 'PCM', OPUS: 'Opus', G726: 'G.726', 'G726-32': 'G.726', MPA: 'MP3' };

function parseSdp(sdp) {
  const out = { video: null, audio: null };
  let cur = null;
  for (const raw of String(sdp || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      const m = line.match(/^m=(\w+)\s+\d+\s+\S+\s+(\d+)/);
      cur = m ? { type: m[1], pt: m[2], codec: null, control: null } : null;
      if (cur && (cur.type === 'video' || cur.type === 'audio') && !out[cur.type]) out[cur.type] = cur;
      else cur = null;
      // payload type แบบ static
      if (cur && cur.type === 'audio') { if (cur.pt === '0') cur.codec = 'G.711 µ-law'; if (cur.pt === '8') cur.codec = 'G.711 A-law'; }
      if (cur && cur.type === 'video' && cur.pt === '26') cur.codec = 'MJPEG';
    } else if (cur && line.startsWith('a=rtpmap:')) {
      const m = line.match(/^a=rtpmap:(\d+)\s+([^/\s]+)/);
      if (m && m[1] === cur.pt) {
        const n = m[2].toUpperCase();
        cur.codec = (cur.type === 'video' ? VIDEO_NAMES[n] : AUDIO_NAMES[n]) || n;
      }
    } else if (cur && line.startsWith('a=framerate:')) {
      cur.fps = parseFloat(line.split(':')[1]);
    } else if (cur && line.startsWith('a=x-dimensions:')) {
      const [w, h] = line.split(':')[1].split(',').map(Number);
      cur.width = w; cur.height = h;
    }
  }
  return out;
}

/**
 * ส่ง RTSP DESCRIBE เพื่อตรวจว่า path นี้ใช้ได้ไหม (รองรับ Basic/Digest)
 * คืนค่า { status, ok, authFailed, sdp, info, server, error }
 *   status: รหัส RTSP (200 = ใช้ได้, 401 = รหัสผ่านผิด/ต้อง auth, 404 = ไม่พบ path)
 */
function describe({ host, port = 554, path = '/', user, pass, timeout = 3500 }) {
  const url = `rtsp://${host}:${port}${path.startsWith('/') ? path : '/' + path}`;
  const hasCred = user !== undefined && user !== '';
  return new Promise((resolve) => {
    let sock, buf = Buffer.alloc(0), cseq = 1, challenges = null, authAttempts = 0, reconnected = false, finished = false;
    const finish = (r) => {
      if (finished) return; finished = true;
      clearTimeout(timer); try { sock && sock.destroy(); } catch {}
      resolve({ url, ...r });
    };
    const timer = setTimeout(() => finish({ status: 0, ok: false, error: 'timeout' }), timeout);

    const send = () => {
      let h = `DESCRIBE ${url} RTSP/1.0\r\nCSeq: ${cseq++}\r\nUser-Agent: CCTV-Tech/1.0\r\nAccept: application/sdp\r\n`;
      if (authAttempts > 0 && challenges) {
        const authz = buildAuthorization(challenges, { method: 'DESCRIBE', uri: url, user: user || '', pass: pass || '' });
        if (authz) h += `Authorization: ${authz}\r\n`;
      }
      try { sock.write(h + '\r\n'); } catch {}
    };
    const connect = () => {
      buf = Buffer.alloc(0);
      sock = net.createConnection({ host, port }, send);
      sock.on('data', onData);
      sock.on('error', (e) => finish({ status: 0, ok: false, error: e.code || e.message }));
      // กล้องบางรุ่นปิด connection หลังตอบ 401 → เชื่อมต่อใหม่ 1 ครั้ง
      sock.on('close', () => {
        if (finished) return;
        if (!reconnected) { reconnected = true; connect(); } else finish({ status: 0, ok: false, error: 'closed' });
      });
    };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.slice(0, end).toString('latin1');
      const lines = head.split(/\r\n/);
      const st = lines[0].match(/^RTSP\/\d\.\d\s+(\d+)/);
      if (!st) return finish({ status: 0, ok: false, error: 'bad-response' });
      const status = Number(st[1]);
      const headers = {};
      const wwwAuth = [];
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':'); if (i < 0) continue;
        const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim();
        if (k === 'www-authenticate') wwwAuth.push(v);
        headers[k] = v;
      }
      const need = parseInt(headers['content-length'] || '0', 10);
      if (buf.length < end + 4 + need) return; // รออ่าน body ให้ครบ
      const body = buf.slice(end + 4, end + 4 + need).toString('utf8');
      buf = buf.slice(end + 4 + need);
      if (status === 401) {
        if (!hasCred) return finish({ status, ok: false, authFailed: true, needAuth: true, server: headers.server });
        const fresh = parseChallenges(wwwAuth);
        if (!fresh.length) return finish({ status, ok: false, authFailed: true, server: headers.server });
        if (authAttempts === 0) {
          challenges = fresh; authAttempts = 1;
          return send();                       // ส่งซ้ำพร้อมรหัสผ่านใน connection เดิม
        }
        // ส่ง Authorization แล้วยังโดน 401: ถ้าเป็นเพราะ nonce เก่าข้าม connection ให้ลองอีกครั้งด้วย nonce ใหม่
        if (reconnected && authAttempts === 1 && fresh[0].params.nonce !== (challenges[0].params || {}).nonce) {
          challenges = fresh; authAttempts = 2;
          return send();
        }
        return finish({ status, ok: false, authFailed: true, server: headers.server });
      }
      if (status === 200) return finish({ status, ok: true, sdp: body, info: parseSdp(body), server: headers.server });
      finish({ status, ok: false, server: headers.server });
    };
    connect();
  });
}

module.exports = { describe, parseSdp };
