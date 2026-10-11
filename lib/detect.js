'use strict';
const { tcpCheck, pool, maskUrl } = require('./util');
const { describe } = require('./rtsp');
const { Onvif } = require('./onvif');
const { request } = require('./httpclient');
const { buildCandidates, normalizeBrand, BRAND_LABEL, fingerprint } = require('./brands');
const { XMLParser } = require('fast-xml-parser');

const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, parseTagValue: false });

class DetectError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const enc = (s) => encodeURIComponent(s || '');
function buildUrl({ host, port, path, user, pass, noUserinfo }) {
  const auth = user && !noUserinfo ? `${enc(user)}:${enc(pass)}@` : '';
  return `rtsp://${auth}${host}:${port}${path.startsWith('/') ? path : '/' + path}`;
}

/** ดึงชื่อรุ่นจาก API เฉพาะยี่ห้อ (ใช้ยืนยันรหัสผ่านไปในตัว) */
async function vendorInfo(host, port, family, user, pass) {
  try {
    if (family === 'dahua') {
      const r = await request({ host, port, path: '/cgi-bin/magicBox.cgi?action=getSystemInfo', user, pass, timeout: 3000 });
      if (r.status === 401) return { auth: false };
      if (r.status === 200) {
        const m = r.body.match(/deviceType=(.+)/); const sn = r.body.match(/serialNumber=(.+)/);
        return { auth: true, model: m && m[1].trim(), serial: sn && sn[1].trim() };
      }
    }
    if (family === 'hikvision') {
      const r = await request({ host, port, path: '/ISAPI/System/deviceInfo', user, pass, timeout: 3000 });
      if (r.status === 401) return { auth: false };
      if (r.status === 200) {
        const d = xml.parse(r.body).DeviceInfo || {};
        return { auth: true, model: d.model, firmware: d.firmwareVersion, serial: d.serialNumber };
      }
    }
  } catch {}
  return {};
}

/**
 * ค้นหาวิธีเชื่อมต่อกล้องอัตโนมัติ: ช่างกรอกแค่ IP / user / pass / main-sub
 * @returns ข้อมูลสำหรับเปิดสตรีม + PTZ
 */
async function detect(opts, emit = () => {}) {
  const ip = String(opts.ip || '').trim();
  const user = opts.user || '';
  const pass = opts.pass || '';
  const kind = opts.stream === 'sub' ? 'sub' : 'main';
  const channel = Math.max(1, Number(opts.channel) || 1);
  const cred = { user, pass };
  const t0 = Date.now();
  const timeLeft = () => 75000 - (Date.now() - t0);

  if (!ip) throw new DetectError('INPUT', 'กรุณาใส่ IP Address ของกล้อง');
  if (!/^[\w.\-]+$/.test(ip)) throw new DetectError('INPUT', 'รูปแบบ IP Address ไม่ถูกต้อง');

  // ---------- 0) URL กำหนดเอง ----------
  if (opts.customUrl) {
    const m = String(opts.customUrl).trim().match(/^rtsp:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/]+)(?::(\d+))?(\/.*)?$/i);
    if (!m) throw new DetectError('INPUT', 'RTSP URL ที่กำหนดเองไม่ถูกต้อง (ต้องขึ้นต้นด้วย rtsp://)');
    const cu = decodeURIComponent(m[1] || user), cp = decodeURIComponent(m[2] !== undefined ? m[2] : pass);
    const port = Number(m[4] || 554), path = m[5] || '/';
    emit('info', `ทดสอบ RTSP URL ที่กำหนดเอง ${maskUrl(opts.customUrl)}`);
    const r = await describe({ host: m[3], port, path, user: cu, pass: cp });
    if (!r.ok) throw new DetectError(r.authFailed ? 'AUTH' : 'NOPATH', r.authFailed ? 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' : `เชื่อมต่อ URL นี้ไม่ได้ (RTSP ${r.status || r.error})`);
    return { host: m[3], rtspPort: port, path, url: buildUrl({ host: m[3], port, path, user: cu, pass: cp }), kind, usedKind: kind, brandKey: null, brandLabel: 'ไม่ทราบ (URL กำหนดเอง)', sdp: r.info, ptz: { family: null, httpPort: 80, onvif: null }, streams: [], credsVerified: true };
  }

  // ---------- 1) ตรวจพอร์ต ----------
  emit('info', `กำลังตรวจสอบการเชื่อมต่อไปยัง ${ip} ...`);
  const rtspPorts = [...new Set([Number(opts.port) || 0, 554, 8554, 10554].filter(Boolean))];
  const httpPortsAll = [80, 8080, 8000, 8899, 2020, 88];
  const [rtspOpen, httpOpen] = await Promise.all([
    Promise.all(rtspPorts.map(async (p) => ((await tcpCheck(ip, p, 1200)) ? p : 0))).then((a) => a.filter(Boolean)),
    Promise.all(httpPortsAll.map(async (p) => ((await tcpCheck(ip, p, 1200)) ? p : 0))).then((a) => a.filter(Boolean)),
  ]);
  if (!rtspOpen.length && !httpOpen.length) {
    const sdk = (await tcpCheck(ip, 37777, 800)) || (await tcpCheck(ip, 34567, 800));
    throw new DetectError('NOHOST', sdk
      ? `ติดต่อ ${ip} ได้ แต่พอร์ต RTSP/HTTP ปิดอยู่ — เข้าเมนูกล้อง/NVR แล้วเปิด RTSP (หรือ ONVIF) ก่อน`
      : `ติดต่อ ${ip} ไม่ได้ — ตรวจสอบ IP, สายแลน/ไฟเลี้ยง และให้เครื่องช่างอยู่ในวงเครือข่ายเดียวกับกล้อง`);
  }
  emit('info', `พบพอร์ตที่เปิดอยู่: ${[...rtspOpen.map((p) => `RTSP ${p}`), ...httpOpen.map((p) => `HTTP ${p}`)].join(', ')}`);

  // ---------- 2) ระบุยี่ห้อ / รุ่น / ONVIF ----------
  let brandKey = opts.brand && opts.brand !== 'auto' ? opts.brand : null;
  let brandVia = brandKey ? 'ช่างเลือกเอง' : '';
  let httpPortForApi = httpOpen[0] || 80;
  let family = null;
  let credsVerified = false;
  let onvif = null, onvifStreams = null, model = '', firmware = '', serial = '';

  if (httpOpen.length) {
    const fp = await fingerprint(ip, httpOpen);
    if (!brandKey && fp.brand) { brandKey = fp.brand; brandVia = fp.via; }
    if (fp.port && (fp.brand === 'dahua' || fp.brand === 'hikvision')) httpPortForApi = fp.port;
  }
  // ONVIF
  const onvifPorts = httpOpen.filter((p) => p !== 8000 || brandKey !== 'hikvision').concat(httpOpen.includes(8000) ? [8000] : []);
  for (const p of [...new Set(onvifPorts)]) {
    const o = new Onvif({ host: ip, port: p, user, pass });
    if (await o.probe()) { onvif = o; break; }
  }
  if (onvif) {
    try {
      const di = await onvif.getDeviceInformation();
      credsVerified = true;
      model = di.model || ''; firmware = di.firmware || ''; serial = di.serial || '';
      const nb = normalizeBrand(`${di.manufacturer} ${di.model}`);
      if (nb && !opts.brand) { brandKey = nb; brandVia = `ONVIF (${di.manufacturer})`; }
      else if (!brandKey && di.manufacturer) { brandVia = `ONVIF (${di.manufacturer})`; }
      onvif.manufacturer = di.manufacturer;
      await onvif.loadServices();
      onvifStreams = await onvif.discoverStreams();
      emit('info', `พบ ONVIF บนกล้อง (${onvifStreams.all.length} สตรีม)`);
    } catch (e) {
      if (e.code === 'AUTH') emit('warn', 'ONVIF: ชื่อผู้ใช้/รหัสผ่านไม่ผ่าน (จะลองยืนยันกับ RTSP/ยี่ห้ออีกครั้ง)');
      else emit('warn', `อ่านข้อมูลผ่าน ONVIF ไม่สำเร็จ: ${e.message}`);
      if (e.code !== 'AUTH') { /* ยังใช้งาน PTZ ผ่าน ONVIF ได้เมื่อ profile ว่าง? ไม่ — ปิดไว้ */ }
      if (!onvif.profiles.length) { if (e.code === 'AUTH') onvif.authFailed = true; }
    }
  }
  family = brandKey === 'dahua' ? 'dahua' : brandKey === 'hikvision' ? 'hikvision' : null;
  if (family) {
    const vi = await vendorInfo(ip, httpPortForApi, family, user, pass);
    if (vi.auth === true) { credsVerified = true; model = model || vi.model || ''; firmware = firmware || vi.firmware || ''; serial = serial || vi.serial || ''; }
    if (vi.auth === false && !credsVerified) {
      throw new DetectError('AUTH', `ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง (${BRAND_LABEL[family]} ปฏิเสธการเข้าสู่ระบบ) — กรุณาตรวจสอบแล้วลองใหม่ (ระวัง: กรอกผิดหลายครั้งกล้องอาจล็อกบัญชีชั่วคราว)`);
    }
  }
  if (brandKey) emit('info', `ตรวจพบยี่ห้อ: ${BRAND_LABEL[brandKey] || brandKey}${model ? ' รุ่น ' + model : ''}${brandVia ? ` (จาก ${brandVia})` : ''}`);
  else emit('warn', 'ยังไม่ทราบยี่ห้อ จะลองรูปแบบ RTSP ที่พบบ่อยทั้งหมด');

  // ---------- 3) หา RTSP path ----------
  const candidates = [];
  const addCand = (c) => { if (!candidates.some((x) => x.port === c.port && x.path === c.path)) candidates.push(c); };

  if (opts.cached && opts.cached.path) addCand({ port: opts.cached.port || rtspOpen[0] || 554, path: opts.cached.path, via: 'จากครั้งก่อน', noUserinfo: !!opts.cached.noUserinfo });
  if (onvifStreams && onvifStreams.all.length) {
    const pick = kind === 'sub' ? (onvifStreams.sub || onvifStreams.main) : onvifStreams.main;
    const ordered = [pick, ...onvifStreams.all.filter((p) => p !== pick && ((kind === 'sub') === (p === onvifStreams.sub)))].filter(Boolean);
    for (const p of ordered) {
      try {
        const u = new URL(p.uri.replace(/^rtsp:\/\/[^@/]*@/i, 'rtsp://'));
        addCand({ port: Number(u.port || 554), path: u.pathname + u.search, via: `ONVIF (${p.width}x${p.height})` });
      } catch {}
    }
  }
  const rp = rtspOpen.length ? rtspOpen : [Number(opts.port) || 554];
  const templ = buildCandidates(kind, channel, cred, brandKey);
  for (const c of templ) for (const port of rp) addCand({ port, path: c.path, via: c.brand, noUserinfo: c.noUserinfo, single: c.single, preferred: c.preferred });

  if (!rtspOpen.length && !candidates.some((c) => c.via && c.via.startsWith('ONVIF'))) {
    throw new DetectError('NORTSP', `ไม่พบพอร์ต RTSP (${rtspPorts.join('/')}) บนกล้องนี้ — เข้าเมนูกล้องเพื่อเปิด RTSP หรือใส่พอร์ตใน "ตัวเลือกเพิ่มเติม" (กล้องบางรุ่นเก่ามากไม่รองรับ RTSP)`);
  }

  emit('info', `กำลังค้นหา RTSP ${kind === 'main' ? 'Main' : 'Sub'} Stream อัตโนมัติ (${candidates.length} รูปแบบ) ...`);
  let found = null, authFail = 0, tried = 0, abort = null;

  const tryOne = async (c) => {
    if (found || abort) return;
    if (timeLeft() <= 0) { abort = new DetectError('TIMEOUT', 'ค้นหา RTSP นานเกินกำหนด'); return; }
    const r = await describe({ host: ip, port: c.port, path: c.path, user, pass, timeout: 3500 });
    tried++;
    if (r.ok && !found) { found = { ...c, info: r.info, sdp: r.sdp }; return; }
    if (r.authFailed && !r.needAuth) authFail++;
    if (r.authFailed && r.needAuth && !user) abort = new DetectError('AUTH', 'กล้องนี้ต้องใช้ชื่อผู้ใช้/รหัสผ่าน กรุณากรอกให้ครบ');
    if (authFail >= 2 && !credsVerified && !found) abort = new DetectError('AUTH', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง — กรุณาตรวจสอบแล้วลองใหม่ (ระวัง: กรอกผิดหลายครั้งกล้องอาจล็อกบัญชีชั่วคราว)');
    if (tried % 8 === 0 && !found) emit('info', `ลองแล้ว ${tried}/${candidates.length} รูปแบบ ...`);
  };
  // 3 ตัวแรกลองทีละตัว (กันล็อกบัญชีถ้ารหัสผิด) ที่เหลือลองพร้อมกัน 3 ตัว
  const head = candidates.slice(0, 3), rest = candidates.slice(3);
  for (const c of head) await tryOne(c);
  if (!found && !abort) await pool(rest, 3, tryOne);
  if (abort && !found) throw abort;

  // ---------- 4) ไม่เจอ sub → ลอง main ----------
  let usedKind = kind;
  if (!found && kind === 'sub') {
    emit('warn', 'ไม่พบ Sub Stream — ลองใช้ Main Stream แทน');
    const r2 = await detect({ ...opts, stream: 'main', cached: null, brand: brandKey || opts.brand }, emit);
    r2.usedKind = 'main'; r2.fallbackFromSub = true;
    return r2;
  }
  if (!found) {
    throw new DetectError('NOPATH', `เชื่อมต่อกล้องได้ แต่ไม่พบ RTSP path ที่ใช้ได้ (ลอง ${tried} รูปแบบ) — กล้องอาจปิด RTSP, ใช้ชื่อผู้ใช้ที่ไม่มีสิทธิ์ดูภาพสด หรือเป็นรุ่นที่ใช้โปรโตคอลเฉพาะ ลองใส่ RTSP URL เองใน "ตัวเลือกเพิ่มเติม"`);
  }

  const url = buildUrl({ host: ip, port: found.port, path: found.path, user, pass, noUserinfo: found.noUserinfo });
  emit('ok', `พบ RTSP ที่ใช้ได้: ${maskUrl(url)} (${found.via})`);
  return {
    host: ip, rtspPort: found.port, path: found.path, noUserinfo: !!found.noUserinfo, url, kind, usedKind,
    brandKey, brandLabel: brandKey ? BRAND_LABEL[brandKey] : (found.preferred ? found.via : 'ไม่ทราบยี่ห้อ'),
    brandVia, model, firmware, serial, sdp: found.info, found: found.via,
    ptz: { family, httpPort: httpPortForApi, onvif: onvif && onvif.profiles && onvif.profiles.length ? onvif : null },
    streams: onvifStreams ? onvifStreams.all.map((p) => ({ name: p.name, token: p.token, width: p.width, height: p.height, encoding: p.encoding, fps: p.fps })) : [],
    credsVerified: credsVerified || true,
  };
}

module.exports = { detect, DetectError, buildUrl };
