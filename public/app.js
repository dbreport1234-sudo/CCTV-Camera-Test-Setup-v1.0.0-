'use strict';
const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');
const hhmmss = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  session: null, phase: 'idle', cameras: [], selId: null, passDirty: false,
  player: null, audioOn: false, recording: null, zoom: 1, pan: { x: 0, y: 0 }, info: { video: null, audio: null },
  speed: 4, hasFrame: false,
};

async function api(url, body, method) {
  const opt = { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok && !j.error) j.error = `HTTP ${r.status}`;
  j._status = r.status;
  return j;
}
let toastT;
function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, 3600);
}

/* ---------------- นาฬิกา ---------------- */
function tick() {
  const d = new Date();
  $('clkTime').textContent = hhmmss(d);
  $('clkDate').textContent = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  if (!$('ovTime').hidden) $('ovTime').textContent = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}  ${hhmmss(d)}`;
  if (S.recording) { const s = Math.floor((Date.now() - S.recording.startedAt) / 1000); $('recTimer').textContent = `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`; }
}
setInterval(tick, 500);

/* ---------------- สถานะ ---------------- */
function addLog(level, msg, t) {
  const box = $('log');
  const row = document.createElement('div');
  row.className = 'row ' + (level || 'info');
  row.innerHTML = `<span class="t">${hhmmss(t ? new Date(t) : new Date())}</span><span class="m">${esc(msg)}</span>`;
  box.appendChild(row);
  while (box.children.length > 120) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
function setPhase(phase) {
  S.phase = phase;
  const pill = $('readyPill'), txt = $('readyText');
  pill.className = 'ready' + (phase === 'connecting' ? ' busy' : phase === 'error' ? ' err' : '');
  txt.textContent = phase === 'connecting' ? 'กำลังเชื่อมต่อ...' : phase === 'error' ? 'มีปัญหา' : phase === 'connected' ? 'เชื่อมต่อกล้องแล้ว' : 'พร้อมใช้งาน';
  $('connectBtn').disabled = phase === 'connecting';
  $('connectLabel').textContent = phase === 'connecting' ? 'กำลังเชื่อมต่อ...' : 'เชื่อมต่อกล้อง';
  const st = $('iState');
  st.innerHTML = phase === 'connected' ? '<span class="dot"></span><b style="color:#4ade80">ออนไลน์</b>' : phase === 'connecting' ? '<span class="dot warn"></span> กำลังเชื่อมต่อ' : '<span class="dot idle"></span> ออฟไลน์';
}
function connLine(kind, text, brandText) {
  const dotCls = kind === 'ok' ? '' : kind === 'wait' ? 'warn' : kind === 'bad' ? 'err' : 'idle';
  $('connLine1').innerHTML = `<span class="dot ${dotCls}"></span><span class="${kind}">${esc(text)}</span>`;
  $('connLine2').innerHTML = `<span class="ring"></span><span>${esc(brandText || 'ยี่ห้อ: -')}</span>`;
}

/* ---------------- WebSocket เหตุการณ์ ---------------- */
function connectEvents() {
  const ws = new WebSocket(`ws://${location.host}/ws/events`);
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'log') addLog(e.level, e.msg, e.t);
    else if (e.type === 'stream-info') { S.info = e.info; renderInfo(); }
    else if (e.type === 'rec') onRec(e);
    else if (e.type === 'cameras') loadCameras();
    else if (e.type === 'status') { if (e.phase !== 'connected' || S.session) setPhase(e.phase); if (e.phase === 'error' && S.session) { showPlaceholder('สตรีมขาด', 'ลองกด “เชื่อมต่อกล้อง” อีกครั้ง'); } }
    else if (e.type === 'scan') onScan(e);
  };
  ws.onclose = () => setTimeout(connectEvents, 1500);
}

/* ---------------- ข้อมูลกล้อง ---------------- */
function renderInfo() {
  const s = S.session, v = S.info.video, a = S.info.audio;
  $('iBrand').textContent = s ? s.brand : '-';
  $('iModel').textContent = s && s.model ? s.model : '-';
  $('iRes').textContent = v && v.width ? `${v.width}x${v.height}` : '-';
  $('iFps').textContent = v && v.fps ? v.fps : (s && s.sdp && s.sdp.video && s.sdp.video.fps) || '-';
  $('iCodec').textContent = v ? v.codec : (s && s.sdp && s.sdp.video && s.sdp.video.codec) || '-';
  $('iAudio').textContent = a ? `${a.codec}${a.rate ? ' ' + a.rate / 1000 + 'kHz' : ''}` : (s ? (s.sdp && s.sdp.audio ? s.sdp.audio.codec : 'ไม่มีเสียง') : '-');
  renderSettingsInfo();
}
function renderSettingsInfo() {
  const s = S.session, box = $('setInfo');
  if (!s) { box.innerHTML = '<span class="muted">ยังไม่ได้เชื่อมต่อกล้อง</span>'; $('streamsBox').innerHTML = ''; return; }
  const v = S.info.video;
  const rows = [
    ['IP', s.ip], ['ยี่ห้อ', s.brand + (s.brandVia ? `  (จาก ${s.brandVia})` : '')], ['รุ่น', s.model || '-'], ['Firmware', s.firmware || '-'], ['Serial', s.serial || '-'],
    ['สตรีมที่ใช้', (s.usedKind === 'main' ? 'Main Stream' : 'Sub Stream') + (s.fallbackFromSub ? '  (ไม่พบ Sub → ใช้ Main แทน)' : '')],
    ['RTSP', `${s.urlMasked}`], ['พบ path จาก', s.foundVia || '-'],
    ['วิดีโอ', v ? `${v.codec} ${v.width}x${v.height} @ ${v.fps || '?'} fps` : '-'],
    ['PTZ', s.ptz.family ? `${s.ptz.family}${s.ptz.onvif ? ' + ONVIF' : ''}` : (s.ptz.onvif ? 'ONVIF' : 'ไม่พบโปรโตคอล PTZ (อาจเป็นกล้องที่ไม่มี PTZ)')],
  ];
  box.innerHTML = rows.map(([k, val]) => `<span>${esc(k)}</span><span>${esc(val)}</span>`).join('');
  $('streamsBox').innerHTML = s.streams && s.streams.length
    ? `<h3>สตรีมทั้งหมดที่กล้องแจ้งผ่าน ONVIF</h3><table class="st"><tr><th>ชื่อ</th><th>ความละเอียด</th><th>Codec</th><th>FPS</th></tr>${s.streams.map((p) => `<tr><td>${esc(p.name || p.token)}</td><td>${p.width}x${p.height}</td><td>${esc(p.encoding || '')}</td><td>${p.fps || '-'}</td></tr>`).join('')}</table>` : '';
}

/* ---------------- ตัวเล่นวิดีโอ (JSMpeg) ---------------- */
function showPlaceholder(title, text, loading) {
  $('placeholder').hidden = false; $('placeholder').classList.toggle('loading', !!loading);
  $('phTitle').textContent = title; $('phText').textContent = text;
}
function stopPlayer() {
  if (S.player) { try { S.player.destroy(); } catch {} S.player = null; }
  S.hasFrame = false; resetZoom();
  $('ovTitle').hidden = true; $('ovTime').hidden = true;
}
function startPlayer() {
  stopPlayer();
  showPlaceholder('กำลังเปิดภาพ...', 'รอรับสตรีมจากกล้อง', true);
  const s = S.session;
  $('ovTitle').innerHTML = `${esc(s.ip)} - ${esc(s.label)}<br>${s.usedKind === 'main' ? 'Main Stream' : 'Sub Stream'}`;
  S.player = new JSMpeg.Player(`ws://${location.host}/ws/video`, {
    canvas: $('cv'), audio: true, video: true, autoplay: true, pauseWhenHidden: false,
    videoBufferSize: 6 * 1024 * 1024, audioBufferSize: 512 * 1024, disableGl: false,
    onVideoDecode: () => {
      if (S.hasFrame) return; S.hasFrame = true;
      $('placeholder').hidden = true; $('ovTitle').hidden = false; $('ovTime').hidden = false;
      applyVolume();
    },
  });
  applyVolume();
}
function applyVolume() {
  if (!S.player) return;
  try { S.player.volume = S.audioOn ? 1 : 0; } catch {}
  try { const c = S.player.audioOut && S.player.audioOut.context; if (c && c.state === 'suspended' && S.audioOn) c.resume(); } catch {}
}
function renderAudioButtons() {
  $('tbAudio').innerHTML = icon(S.audioOn ? 'vol' : 'vol-x');
  $('tbAudio').classList.toggle('on', S.audioOn);
  $('actAudio').classList.toggle('on', S.audioOn);
}
function toggleAudio() {
  if (!S.session) return toast('ยังไม่ได้เชื่อมต่อกล้อง', true);
  if (!S.audioOn && S.info.video && !S.info.audio) { toast('กล้องตัวนี้ไม่ได้ส่งเสียงมา (ไมค์ในกล้องปิดอยู่หรือไม่มีไมค์)', true); return; }
  S.audioOn = !S.audioOn; applyVolume(); renderAudioButtons();
  addLog(S.audioOn ? 'ok' : 'info', S.audioOn ? 'เปิดเสียงสำเร็จ' : 'ปิดเสียงแล้ว');
}

/* ซูมดิจิทัล */
function applyZoom() {
  const z = S.zoom, w = $('screen');
  const maxX = (w.clientWidth * (z - 1)), maxY = (w.clientHeight * (z - 1));
  S.pan.x = Math.min(0, Math.max(-maxX, S.pan.x)); S.pan.y = Math.min(0, Math.max(-maxY, S.pan.y));
  $('cvWrap').style.transform = `translate(${S.pan.x}px,${S.pan.y}px) scale(${z})`;
  $('tbZoom').textContent = (Math.round(z * 10) / 10) + 'x';
}
function resetZoom() { S.zoom = 1; S.pan = { x: 0, y: 0 }; applyZoom(); }
function zoomAt(newZ, cx, cy) {
  const old = S.zoom; newZ = Math.min(8, Math.max(1, newZ));
  S.pan.x = cx - (cx - S.pan.x) * (newZ / old); S.pan.y = cy - (cy - S.pan.y) * (newZ / old);
  S.zoom = newZ; if (newZ === 1) S.pan = { x: 0, y: 0 }; applyZoom();
}
$('screen').addEventListener('wheel', (e) => {
  e.preventDefault(); const r = $('screen').getBoundingClientRect();
  zoomAt(S.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
let drag = null;
$('screen').addEventListener('pointerdown', (e) => { if (S.zoom > 1) { drag = { x: e.clientX, y: e.clientY, px: S.pan.x, py: S.pan.y }; $('screen').setPointerCapture(e.pointerId); } });
$('screen').addEventListener('pointermove', (e) => { if (drag) { S.pan.x = drag.px + e.clientX - drag.x; S.pan.y = drag.py + e.clientY - drag.y; applyZoom(); } });
$('screen').addEventListener('pointerup', () => { drag = null; });
$('screen').addEventListener('dblclick', resetZoom);
$('tbZoom').onclick = () => { const r = $('screen').getBoundingClientRect(); zoomAt(S.zoom >= 4 ? 1 : S.zoom < 2 ? 2 : 4, r.width / 2, r.height / 2); };
$('tbFull').onclick = () => { const el = $('screen'); if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen().catch(() => {}); };
document.addEventListener('fullscreenchange', () => { $('screen').style.margin = document.fullscreenElement ? '0' : ''; });

/* ---------------- เชื่อมต่อ ---------------- */
function formData() {
  return {
    ip: $('ip').value.trim(), user: $('user').value, pass: $('pass').value, stream: $('stream').value,
    port: $('advPort').value.trim(), channel: $('advCh').value.trim() || '1', brand: $('advBrand').value, customUrl: $('advUrl').value.trim(),
  };
}
async function connect() {
  const f = formData();
  if (!f.ip) { toast('กรุณาใส่ IP Address', true); $('ip').focus(); return; }
  const body = { ...f };
  if (S.selId) {
    const cam = S.cameras.find((c) => c.id === S.selId);
    if (cam && cam.ip === f.ip) { body.savedId = cam.id; if (!S.passDirty) body.pass = ''; }
  }
  connLine('wait', 'กำลังเชื่อมต่อ...', 'ยี่ห้อ: กำลังตรวจสอบ');
  setPhase('connecting');
  showPlaceholder('กำลังค้นหาวิธีเชื่อมต่อ...', 'ระบบกำลังตรวจยี่ห้อและหา RTSP ให้อัตโนมัติ ใช้เวลาไม่กี่วินาที', true);
  stopPlayer(); showPlaceholder('กำลังค้นหาวิธีเชื่อมต่อ...', 'ระบบกำลังตรวจยี่ห้อและหา RTSP ให้อัตโนมัติ ใช้เวลาไม่กี่วินาที', true);
  S.session = null; S.info = { video: null, audio: null }; renderInfo();
  const r = await api('/api/connect', body);
  if (r.error) {
    setPhase('error'); connLine('bad', 'เชื่อมต่อไม่สำเร็จ', 'ยี่ห้อ: -');
    showPlaceholder('เชื่อมต่อไม่สำเร็จ', r.error); toast(r.error, true); return;
  }
  S.session = r.session; setPhase('connected');
  connLine('ok', 'เชื่อมต่อสำเร็จ!', `ยี่ห้อ: ${r.session.brand} (RTSP)`);
  if (r.session.fallbackFromSub) toast('ไม่พบ Sub Stream ในกล้องนี้ จึงใช้ Main Stream แทน');
  renderInfo(); startPlayer(); loadPresets();
  if (S.selId) loadCameras();
}
$('connectBtn').onclick = connect;
['ip', 'user', 'pass'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); }));
$('pass').addEventListener('input', () => { S.passDirty = true; });
$('ip').addEventListener('input', () => { S.selId = null; renderCameras(); });
$('pwEye').onclick = () => { const p = $('pass'); const show = p.type === 'password'; p.type = show ? 'text' : 'password'; $('pwEye').innerHTML = icon(show ? 'eye-off' : 'eye'); };

/* ---------------- รายการกล้อง ---------------- */
async function loadCameras() {
  S.cameras = await api('/api/cameras');
  renderCameras(); renderThumbs();
}
function renderCameras() {
  const q = $('camSearch').value.trim().toLowerCase();
  const list = S.cameras.filter((c) => !q || c.name.toLowerCase().includes(q) || c.ip.includes(q));
  $('camList').innerHTML = list.length ? list.map((c) => `<div class="cam-item ${c.id === S.selId ? 'sel' : ''}" data-id="${c.id}">${icon('cams', 24)}<div><b>${esc(c.name)}</b><span>${esc(c.ip)} · ${c.stream === 'sub' ? 'Sub' : 'Main'}</span></div></div>`).join('')
    : `<div class="empty-note">${S.cameras.length ? 'ไม่พบกล้องที่ค้นหา' : 'ยังไม่มีกล้องในรายการ<br>เชื่อมต่อกล้องให้สำเร็จ แล้วกด “เพิ่มกล้อง” เพื่อบันทึกไว้ใช้ครั้งต่อไป'}</div>`;
}
function pickCamera(id, doConnect) {
  const c = S.cameras.find((x) => x.id === id); if (!c) return;
  S.selId = id; S.passDirty = false;
  $('ip').value = c.ip; $('user').value = c.user || ''; $('pass').value = c.hasPass ? '••••••••' : '';
  $('stream').value = c.stream || 'main'; $('advPort').value = c.port || ''; $('advCh').value = c.channel || 1; $('advBrand').value = c.brand || 'auto';
  renderCameras(); renderThumbs();
  if (doConnect) connect();
}
$('camList').addEventListener('click', (e) => { const it = e.target.closest('.cam-item'); if (it) pickCamera(Number(it.dataset.id), true); });
$('camSearch').addEventListener('input', renderCameras);
$('addCamBtn').onclick = () => {
  const f = formData();
  if (!f.ip) return toast('กรอก IP กล้องก่อน', true);
  $('nameHint').textContent = S.session ? 'จะบันทึก IP, ชื่อผู้ใช้, รหัสผ่าน และ RTSP path ที่ระบบหาเจอไว้ (รหัสผ่านเก็บในเครื่องนี้ ไม่ได้เข้ารหัส)' : 'ยังไม่ได้เชื่อมต่อ — จะบันทึกค่าที่กรอกไว้ในฟอร์ม (แนะนำให้เชื่อมต่อให้สำเร็จก่อน)';
  $('nameInput').value = ''; $('nameDlg').showModal(); $('nameInput').focus();
};
$('nameCancel').onclick = () => $('nameDlg').close();
$('nameForm').addEventListener('submit', async () => {
  const f = formData(); const name = $('nameInput').value.trim(); if (!name) return;
  const fromSession = !!(S.session && S.session.ip === f.ip);
  const r = await api('/api/cameras', { ...f, name, fromSession });
  if (r.error) return toast(r.error, true);
  S.cameras = r.cameras; S.selId = r.id; S.passDirty = false; renderCameras(); renderThumbs();
  toast(`เพิ่มกล้อง “${name}” แล้ว`);
});
$('delCamBtn').onclick = async () => {
  if (!S.selId) return toast('เลือกกล้องในรายการก่อน', true);
  const c = S.cameras.find((x) => x.id === S.selId);
  if (!confirm(`ลบกล้อง “${c ? c.name : ''}” ออกจากรายการ?`)) return;
  const r = await api(`/api/cameras/${S.selId}`, undefined, 'DELETE');
  if (r.error) return toast(r.error, true);
  S.cameras = r.cameras; S.selId = null; renderCameras(); renderThumbs();
};
function renderThumbs() {
  const withThumb = S.cameras;
  $('thumbs').innerHTML = withThumb.length ? withThumb.map((c) => {
    const t = c.thumbAt ? new Date(c.thumbAt) : null;
    return `<div class="th-item ${c.id === S.selId ? 'sel' : ''}" data-id="${c.id}"><div class="im" style="${t ? `background-image:url('/api/cameras/${c.id}/thumb?t=${encodeURIComponent(c.thumbAt)}')` : ''}">${t ? '' : 'ยังไม่มีภาพ'}</div><div class="cp">${esc(c.name)}<em>${t ? hhmmss(t) : '--:--:--'}</em></div></div>`;
  }).join('') : '<div class="empty-note" style="grid-column:1/-1">ภาพตัวอย่างของกล้องที่บันทึกไว้จะแสดงที่นี่ (สร้างอัตโนมัติทุกครั้งที่เชื่อมต่อ)</div>';
}
$('thumbs').addEventListener('click', (e) => { const it = e.target.closest('.th-item'); if (it) pickCamera(Number(it.dataset.id), true); });

/* ---------------- Snapshot / Record ---------------- */
async function snapshot() {
  if (!S.session) return toast('ยังไม่ได้เชื่อมต่อกล้อง', true);
  const r = await api('/api/snapshot', {});
  if (r.error) return toast(r.error, true);
  $('screen').classList.remove('flash'); void $('screen').offsetWidth; $('screen').classList.add('flash');
  toast('บันทึกภาพแล้ว: ' + r.name); if ($('pane-files').classList.contains('active')) loadFiles();
}
async function toggleRecord() {
  if (!S.session) return toast('ยังไม่ได้เชื่อมต่อกล้อง', true);
  const r = await api(S.recording ? '/api/record/stop' : '/api/record/start', {});
  if (r.error) return toast(r.error, true);
  if (!S.recording) toast('เริ่มบันทึกวิดีโอแล้ว'); else { toast(`หยุดบันทึกแล้ว (${r.seconds} วินาที)`); if ($('pane-files').classList.contains('active')) loadFiles(); }
}
function onRec(e) {
  S.recording = e.recording ? { startedAt: e.startedAt || Date.now(), name: e.name } : null;
  const on = !!S.recording;
  $('ovRec').hidden = !on; $('actRecDot').hidden = !on;
  $('tbRecord').classList.toggle('on', on); $('tbRecDot').classList.toggle('on', on); $('actRec').classList.toggle('on', on);
  $('actRec').querySelector('.reclbl').innerHTML = on ? 'หยุดบันทึก<br>(Stop)' : 'บันทึกวิดีโอ<br>(Record)';
}
$('tbSnap').onclick = $('actSnap').onclick = snapshot;
$('tbRecord').onclick = $('tbRecDot').onclick = $('actRec').onclick = toggleRecord;
$('tbAudio').onclick = $('actAudio').onclick = toggleAudio;

/* ---------------- แท็บ ---------------- */
function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
  if (name === 'files') loadFiles();
  if (name === 'settings') loadSettings();
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) showTab(b.dataset.tab); });
$('actSettings').onclick = () => showTab('settings');
$('actPtz').onclick = () => { showTab('live'); document.querySelector('.ptz').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('ptzOk').focus(); };

/* ---------------- ไฟล์ ---------------- */
function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
async function loadFiles() {
  const r = await api('/api/files');
  $('filesDir').textContent = r.dir ? `(${r.dir})` : '';
  const files = r.files || [];
  $('filesGrid').innerHTML = files.length ? files.map((f) => {
    const isImg = /\.(jpg|jpeg|png)$/i.test(f.name);
    const d = new Date(f.mtime);
    return `<div class="file" data-kind="${f.kind}" data-name="${esc(f.name)}"><div class="th" style="${isImg ? `background-image:url('${f.url}')` : ''}">${isImg ? '' : icon('video', 34)}</div><div class="nm">${esc(f.name)}<em>${fmtSize(f.size)} · ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${hhmmss(d)}</em></div></div>`;
  }).join('') : '<div class="empty-note" style="grid-column:1/-1">ยังไม่มีไฟล์ — กดจับภาพนิ่ง/บันทึกวิดีโอได้ที่หน้า Live View</div>';
}
$('filesGrid').addEventListener('click', async (e) => { const f = e.target.closest('.file'); if (f) { const r = await api('/api/open', { kind: f.dataset.kind, name: f.dataset.name }); if (r.error) toast(r.error, true); } });
$('openSnapDir').onclick = () => api('/api/open', { kind: 'snapshot' });
$('openRecDir').onclick = () => api('/api/open', { kind: 'record' });
$('refreshFiles').onclick = loadFiles;

/* ---------------- ตั้งค่า ---------------- */
async function loadSettings() {
  const st = await api('/api/state');
  $('setOut').value = st.settings.outputDir; $('setTransport').value = st.settings.transport; $('ptzMode').value = st.settings.ptzMode;
  $('aboutLine').textContent = `CCTV Camera Test & Setup v${st.version} · ffmpeg: ${st.ffmpeg}`;
  renderSettingsInfo();
}
$('saveSettings').onclick = async () => {
  const r = await api('/api/settings', { outputDir: $('setOut').value.trim(), transport: $('setTransport').value, ptzMode: $('ptzMode').value });
  if (r.error) return toast(r.error, true); toast('บันทึกการตั้งค่าแล้ว (การส่งข้อมูล RTSP มีผลตอนเชื่อมต่อครั้งถัดไป)');
};
$('ptzMode').addEventListener('change', async () => { await api('/api/settings', { ptzMode: $('ptzMode').value }); toast('เปลี่ยนโปรโตคอล PTZ แล้ว'); });
async function copyUrl(full) {
  if (!S.session) return toast('ยังไม่ได้เชื่อมต่อกล้อง', true);
  let url = S.session.urlMasked;
  if (full) { const r = await api('/api/session/url'); if (r.error) return toast(r.error, true); url = r.url; }
  try { await navigator.clipboard.writeText(url); toast('คัดลอกแล้ว'); } catch { prompt('คัดลอก URL นี้:', url); }
}
$('copyMasked').onclick = () => copyUrl(false); $('copyFull').onclick = () => copyUrl(true);

/* ---------------- PTZ ---------------- */
let ptzChain = Promise.resolve();
const ptzSend = (body) => { ptzChain = ptzChain.then(() => api('/api/ptz', body)).then((r) => { if (r && r.ok === false && body.cmd !== 'stop') toast('PTZ: ' + (r.error || 'กล้องไม่ตอบรับ'), true); return r; }).catch(() => {}); return ptzChain; };
function holdButton(el, start, stop) {
  let on = false;
  const down = (e) => { if (on) return; if (!S.session) { toast('ยังไม่ได้เชื่อมต่อกล้อง', true); return; } on = true; el.classList.add('active'); try { el.setPointerCapture(e.pointerId); } catch {} start(); e.preventDefault(); };
  const up = () => { if (!on) return; on = false; el.classList.remove('active'); stop(); };
  el.addEventListener('pointerdown', down); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('lostpointercapture', up);
}
document.querySelectorAll('[data-ptz]').forEach((b) => holdButton(b, () => ptzSend({ cmd: 'move', dir: b.dataset.ptz, speed: S.speed }), () => ptzSend({ cmd: 'stop', what: 'ptz' })));
document.querySelectorAll('[data-lens]').forEach((b) => holdButton(b, () => ptzSend({ cmd: 'lens', kind: b.dataset.lens, dir: Number(b.dataset.dir), speed: S.speed }), () => ptzSend({ cmd: 'stop', what: b.dataset.lens })));
$('ptzOk').onclick = () => { if (S.session) ptzSend({ cmd: 'stop', what: 'all' }); };
function setSpeed(v) { S.speed = Number(v); $('spd').value = v; $('spd2').value = v; $('spdLabel').textContent = v; $('spdLabel2').textContent = v; }
$('spd').oninput = (e) => setSpeed(e.target.value); $('spd2').oninput = (e) => setSpeed(e.target.value);

async function loadPresets(report) {
  const sel = $('presetSel'); const prev = sel.value;
  const r = S.session ? await api('/api/ptz/presets') : { ok: false, error: 'ยังไม่ได้เชื่อมต่อกล้อง' };
  let opts = [];
  if (r.ok && r.presets && r.presets.length) opts = r.presets.map((p) => ({ id: p.id, label: `${p.id} - ${p.name || 'Preset ' + p.id}` }));
  else opts = Array.from({ length: 16 }, (_, i) => ({ id: String(i + 1), label: `${i + 1} - Preset ${i + 1}` }));
  sel.innerHTML = opts.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
  if (prev && opts.some((o) => o.id === prev)) sel.value = prev;
  if (report) {
    $('ptzTestOut').textContent = r.ok ? `กล้องตอบรับคำสั่ง PTZ ผ่าน ${r.via.toUpperCase()}\nพบ Preset ${r.presets.length} ตำแหน่ง` + (r.presets.length ? '' : ' (ยังไม่ได้ตั้ง — ใช้เลข 1-16 ได้)')
      : `อ่านรายการ Preset ไม่ได้: ${r.error}\n(Dahua ไม่มีคำสั่งอ่านรายชื่อ Preset ส่วนกล้องที่ไม่มี PTZ จะไม่ตอบ — ยังลองกดลูกศรเพื่อทดสอบหมุนได้)`;
  }
}
$('ptzTest').onclick = () => loadPresets(true);
$('presetGo').onclick = async () => { if (!S.session) return toast('ยังไม่ได้เชื่อมต่อกล้อง', true); const r = await ptzSend({ cmd: 'goto', id: $('presetSel').value }); if (r && r.ok) addLog('ok', `ไปที่ Preset ${$('presetSel').value}`); };
$('presetSet').onclick = async () => {
  if (!S.session) return toast('ยังไม่ได้เชื่อมต่อกล้อง', true);
  const id = $('presetSel').value;
  if (!confirm(`บันทึกตำแหน่งกล้องปัจจุบันทับ Preset ${id} ในกล้อง?\n(Preset เดิมของลูกค้าจะถูกเขียนทับ)`)) return;
  const r = await ptzSend({ cmd: 'setpreset', id, name: `Preset ${id}` }); if (r && r.ok) { addLog('ok', `ตั้งค่า Preset ${id} แล้ว`); loadPresets(); }
};
$('tourGo').onclick = async () => { if (!S.session) return toast('ยังไม่ได้เชื่อมต่อกล้อง', true); const r = await ptzSend({ cmd: 'tour', action: 'start', n: $('tourSel').value }); if (r && r.ok) addLog('ok', `เริ่ม Tour ${$('tourSel').value}`); };
$('tourStop').onclick = async () => { if (!S.session) return toast('ยังไม่ได้เชื่อมต่อกล้อง', true); const r = await ptzSend({ cmd: 'tour', action: 'stop', n: $('tourSel').value }); if (r && r.ok) addLog('info', 'หยุด Tour'); };

/* ---------------- สแกนหากล้อง ---------------- */
let scanDevices = new Map();
function renderScan() {
  const list = [...scanDevices.values()].sort((a, b) => a.ip.split('.').reduce((x, y) => x * 256 + +y, 0) - b.ip.split('.').reduce((x, y) => x * 256 + +y, 0));
  $('scanList').innerHTML = list.length ? list.map((d) => `<div class="sc-item"><div><b>${esc(d.ip)}</b><span>${esc([d.brandLabel, d.name || d.model, d.ports && d.ports.length ? 'พอร์ต ' + d.ports.join('/') : '', d.onvif ? 'ONVIF' : ''].filter(Boolean).join(' · ') || 'อุปกรณ์เครือข่าย')}</span></div><button class="btn primary sm" data-ip="${esc(d.ip)}">ใช้ IP นี้</button></div>`).join('')
    : '<div class="empty-note">ยังไม่พบกล้อง...</div>';
}
function onScan(e) {
  if (e.kind === 'progress') { $('scanBar').style.width = (e.total ? Math.round(e.done * 100 / e.total) : 0) + '%'; $('scanMsg').textContent = `กำลังสแกน ${e.done}/${e.total} ที่อยู่ ...`; }
  else if (e.kind === 'found' && e.device) { scanDevices.set(e.device.ip, e.device); renderScan(); }
}
$('scanBtn').onclick = async () => {
  scanDevices = new Map(); renderScan(); $('scanBar').style.width = '0'; $('scanMsg').textContent = 'กำลังสแกน...'; $('scanDlg').showModal();
  const r = await api('/api/scan', {});
  if (r.error) { $('scanMsg').textContent = r.error; return; }
  (r.devices || []).forEach((d) => scanDevices.set(d.ip, d)); renderScan();
  $('scanBar').style.width = '100%'; $('scanMsg').textContent = `สแกนเสร็จ พบ ${scanDevices.size} เครื่อง`;
};
$('scanClose').onclick = () => $('scanDlg').close();
$('scanList').addEventListener('click', (e) => { const b = e.target.closest('[data-ip]'); if (!b) return; S.selId = null; $('ip').value = b.dataset.ip; $('scanDlg').close(); renderCameras(); $('pass').focus(); });

/* ---------------- เริ่มต้น ---------------- */
(async function init() {
  hydrateIcons(); renderAudioButtons(); tick(); setPhase('idle');
  connectEvents();
  const st = await api('/api/state');
  $('ver').textContent = `(v${st.version})`;
  (st.history || []).forEach((h) => addLog(h.level, h.msg, h.t));
  if (!(st.history || []).length) addLog('info', 'พร้อมใช้งาน — กรอก IP / ชื่อผู้ใช้ / รหัสผ่าน แล้วกดเชื่อมต่อกล้อง');
  await loadCameras();
  if (st.session && st.phase === 'connected') {   // หน้าจอรีเฟรชระหว่างเชื่อมต่ออยู่
    S.session = st.session; S.info = st.info || S.info; $('ip').value = st.session.ip; setPhase('connected');
    connLine('ok', 'เชื่อมต่อสำเร็จ!', `ยี่ห้อ: ${st.session.brand} (RTSP)`); renderInfo(); startPlayer(); loadPresets();
    if (st.recording) onRec({ recording: true, startedAt: st.recording.startedAt, name: st.recording.name });
  }
})();
