'use strict';
const { request } = require('./httpclient');
const { tcpCheck } = require('./util');

/**
 * แม่แบบ RTSP path ของยี่ห้อต่าง ๆ  (ระบบจะลองทีละแบบด้วย RTSP DESCRIBE จริง
 * จึงไม่ต้องให้ช่างใส่ URL เอง) — ลำดับ = ความนิยมในตลาด
 * main/sub รับ (ch, cred) คืน path (ต้องขึ้นต้นด้วย /)
 */
const q = (s) => encodeURIComponent(s || '');
const FAMILIES = [
  { id: 'dahua', brand: 'Dahua', main: (c) => `/cam/realmonitor?channel=${c}&subtype=0`, sub: (c) => `/cam/realmonitor?channel=${c}&subtype=1` },
  { id: 'hikvision', brand: 'Hikvision', main: (c) => `/Streaming/Channels/${c}01`, sub: (c) => `/Streaming/Channels/${c}02` },
  { id: 'hikvision-old', brand: 'Hikvision', main: (c) => `/h264/ch${c}/main/av_stream`, sub: (c) => `/h264/ch${c}/sub/av_stream` },
  { id: 'uniview', brand: 'Uniview', main: (c) => `/unicast/c${c}/s0/live`, sub: (c) => `/unicast/c${c}/s1/live` },
  { id: 'uniview-old', brand: 'Uniview', main: () => '/media/video1', sub: () => '/media/video2' },
  { id: 'tplink', brand: 'TP-Link / Tapo', main: () => '/stream1', sub: () => '/stream2' },
  { id: 'reolink', brand: 'Reolink', main: (c) => `/h264Preview_${String(c).padStart(2, '0')}_main`, sub: (c) => `/h264Preview_${String(c).padStart(2, '0')}_sub` },
  { id: 'axis', brand: 'Axis', main: () => '/axis-media/media.amp?videocodec=h264', sub: () => '/axis-media/media.amp?videocodec=h264&resolution=640x480' },
  { id: 'axis-old', brand: 'Axis', main: () => '/mpeg4/media.amp', sub: () => '/mpeg4/media.amp?resolution=320x240' },
  { id: 'hanwha', brand: 'Hanwha / Samsung', main: () => '/profile1/media.smp', sub: () => '/profile2/media.smp' },
  { id: 'vivotek', brand: 'Vivotek', main: () => '/live.sdp', sub: () => '/live2.sdp' },
  { id: 'vivotek2', brand: 'Vivotek', main: () => '/live1s1.sdp', sub: () => '/live1s2.sdp' },
  { id: 'foscam', brand: 'Foscam', main: () => '/videoMain', sub: () => '/videoSub' },
  { id: 'foscam-old', brand: 'Foscam', main: () => '/11', sub: () => '/12' },
  { id: 'xm', brand: 'Xiongmai (XM)', main: (c, cr) => `/user=${q(cr.user)}&password=${q(cr.pass)}&channel=${c}&stream=0.sdp?real_stream`, sub: (c, cr) => `/user=${q(cr.user)}&password=${q(cr.pass)}&channel=${c}&stream=1.sdp?real_stream`, noUserinfo: true },
  { id: 'longse', brand: 'Longse / Provision', main: () => '/av0_0', sub: () => '/av0_1' },
  { id: 'chinese-ch', brand: 'Generic', main: () => '/ch0_0.h264', sub: () => '/ch0_1.h264' },
  { id: 'live-ch', brand: 'Generic', main: () => '/live/ch0', sub: () => '/live/ch1' },
  { id: 'live-ch2', brand: 'Generic', main: (c) => `/live/ch${String(c - 1).padStart(2, '0')}_0`, sub: (c) => `/live/ch${String(c - 1).padStart(2, '0')}_1` },
  { id: 'live-ms', brand: 'Generic', main: () => '/live/main', sub: () => '/live/sub' },
  { id: 'ch-ms', brand: 'Generic', main: (c) => `/ch${c}/main`, sub: (c) => `/ch${c}/sub` },
  { id: 'cam-h264', brand: 'Generic', main: (c) => `/cam${c}/h264`, sub: (c) => `/cam${c}/h264_sub` },
  { id: 'ucast', brand: 'Generic', main: () => '/ucast/11', sub: () => '/ucast/12' },
  { id: 'stream01', brand: 'Generic', main: () => '/stream0', sub: () => '/stream1' },
  { id: 'bosch', brand: 'Bosch', main: () => '/rtsp_tunnel', sub: () => '/rtsp_tunnel?inst=2' },
  { id: 'panasonic', brand: 'Panasonic', main: () => '/MediaInput/h264/stream_1', sub: () => '/MediaInput/h264/stream_2' },
  { id: 'numeric', brand: 'Generic', main: () => '/1', sub: () => '/2' },
  { id: 'video12', brand: 'Generic', main: () => '/video1', sub: () => '/video2' },
  { id: 'single-h264', brand: 'Generic', main: () => '/h264', sub: () => '/h264', single: true },
  { id: 'single-live', brand: 'Generic', main: () => '/live', sub: () => '/live', single: true },
  { id: 'single-root', brand: 'Generic', main: () => '/', sub: () => '/', single: true },
];

/** brand → family ids ที่ควรลองก่อน */
const BRAND_FAMILIES = {
  dahua: ['dahua'], hikvision: ['hikvision', 'hikvision-old'], uniview: ['uniview', 'uniview-old'],
  tplink: ['tplink'], reolink: ['reolink'], axis: ['axis', 'axis-old'], hanwha: ['hanwha'],
  vivotek: ['vivotek', 'vivotek2'], foscam: ['foscam', 'foscam-old'], xm: ['xm'],
  bosch: ['bosch'], panasonic: ['panasonic'], longse: ['longse'],
};

/** แปลงชื่อ Manufacturer (จาก ONVIF/HTTP) เป็น key ภายใน */
function normalizeBrand(s) {
  const t = String(s || '').toLowerCase();
  const map = [
    [/dahua|amcrest|lorex|imou|kbvision|\bdh-|\bipc-hf|\bdhi/, 'dahua'],
    [/hikvision|hilook|ezviz|\bds-[27k][a-z0-9]|annke/, 'hikvision'],
    [/uniview|\bunv\b|\bipc2[0-9]/, 'uniview'],
    [/tp-?link|tapo|vigi/, 'tplink'],
    [/reolink/, 'reolink'],
    [/\baxis (communications|network)|axis-cgi/, 'axis'],
    [/hanwha|wisenet|samsung techwin/, 'hanwha'],
    [/vivotek/, 'vivotek'],
    [/foscam/, 'foscam'],
    [/xiongmai|xmeye|netsurveillance|\bxm\b/, 'xm'],
    [/bosch/, 'bosch'],
    [/panasonic/, 'panasonic'],
    [/longse|provision-isr/, 'longse'],
  ];
  for (const [re, k] of map) if (re.test(t)) return k;
  return null;
}
const BRAND_LABEL = {
  dahua: 'Dahua', hikvision: 'Hikvision', uniview: 'Uniview', tplink: 'TP-Link / Tapo', reolink: 'Reolink', axis: 'Axis',
  hanwha: 'Hanwha / Samsung', vivotek: 'Vivotek', foscam: 'Foscam', xm: 'Xiongmai (XM)', bosch: 'Bosch', panasonic: 'Panasonic', longse: 'Longse / Provision',
};

/**
 * สร้างลำดับ path ที่จะลอง  kind = 'main' | 'sub'
 * คืนเป็น [{ id, brand, path, noUserinfo, single }]
 */
function buildCandidates(kind, channel, cred, brandKey) {
  const first = new Set(BRAND_FAMILIES[brandKey] || []);
  const ordered = [...FAMILIES.filter((f) => first.has(f.id)), ...FAMILIES.filter((f) => !first.has(f.id))];
  const seen = new Set();
  const out = [];
  for (const f of ordered) {
    const path = f[kind](channel, cred);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ id: f.id, brand: f.brand, path, noUserinfo: !!f.noUserinfo, single: !!f.single, preferred: first.has(f.id) });
  }
  return out;
}

/**
 * ตรวจยี่ห้อกล้องจาก HTTP (ไม่ต้องใช้รหัสผ่านก็พอได้ยี่ห้อ)
 * คืน { brand: key|null, via: string, httpPorts: [..] }
 */
async function fingerprint(host, httpPorts, timeout = 2200) {
  const hits = {};
  const add = (k, w, via, port) => { if (!k) return; hits[k] = hits[k] || { score: 0, via, port: null }; hits[k].score += w; if (port && w >= 3 && !hits[k].port) hits[k].port = port; };
  const probes = [];
  for (const port of httpPorts) {
    const g = (path) => request({ host, port, path, timeout }).catch(() => null);
    probes.push((async () => {
      // ตัวควบคุม: path ที่ไม่มีจริง ถ้าตอบ 200/401 เหมือนกันหมด แปลว่าสัญญาณจาก path เฉพาะยี่ห้อใช้ไม่ได้
      const ctrl = await g('/cctv-tech-no-such-path-' + Date.now());
      const informative = !(ctrl && (ctrl.status === 401 || ctrl.status === 200));
      const good = (r) => r && informative && (r.status === 401 || (r.status === 200 && !/<html/i.test(r.body.slice(0, 300))));
      const root = await g('/');
      if (root) {
        const srv = String(root.headers.server || '');
        const text = `${srv} ${root.body.slice(0, 6000)} ${root.headers['www-authenticate'] || ''}`;
        add(normalizeBrand(text), 2, `หน้าเว็บ :${port}`, port);
        if (/DVRDVS-Webs|App-webs|DNVRS-Webs|Hikvision-Webs/i.test(srv)) add('hikvision', 3, `Server: ${srv}`, port);
        if (/\/RPC2_Login|dhwebclient|dahua/i.test(text)) add('dahua', 3, 'หน้า login Dahua', port);
        if (/NetSurveillance|XMEye|xmeye/i.test(text)) add('xm', 3, 'หน้า login XM', port);
      }
      const checks = [
        ['hikvision', '/ISAPI/System/deviceInfo', 'ISAPI'],
        ['dahua', '/cgi-bin/magicBox.cgi?action=getSystemInfo', 'Dahua CGI'],
        ['uniview', '/LAPI/V1.0/System/DeviceInfo', 'Uniview LAPI'],
        ['axis', '/axis-cgi/param.cgi?action=list&group=Brand', 'Axis CGI'],
        ['hanwha', '/stw-cgi/system.cgi?msubmenu=deviceinfo&action=view', 'SUNAPI'],
      ];
      await Promise.all(checks.map(async ([k, p, label]) => {
        const r = await g(p);
        if (good(r)) add(k, 5, `${label} :${port}`, port);
      }));
    })());
  }
  await Promise.all(probes);
  // พอร์ตเฉพาะของยี่ห้อ
  const [p37777, p34567] = await Promise.all([tcpCheck(host, 37777, 700), tcpCheck(host, 34567, 700)]);
  if (p37777) add('dahua', 3, 'พอร์ต 37777');
  if (p34567) add('xm', 3, 'พอร์ต 34567');
  const best = Object.entries(hits).sort((a, b) => b[1].score - a[1].score)[0];
  return best ? { brand: best[0], via: best[1].via, port: best[1].port, hits } : { brand: null, via: '', port: null, hits };
}

module.exports = { FAMILIES, buildCandidates, normalizeBrand, BRAND_LABEL, fingerprint };
