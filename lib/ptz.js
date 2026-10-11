'use strict';
const { request } = require('./httpclient');
const { arr } = require('./util');
const { XMLParser } = require('fast-xml-parser');

const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });
const ISAPI_NS = 'http://www.isapi.org/ver20/XMLSchema';

/**
 * ตัวควบคุม PTZ รวม 3 โปรโตคอล
 *   dahua     → /cgi-bin/ptz.cgi        (Dahua / Amcrest / Lorex / Imou ฯลฯ)
 *   hikvision → /ISAPI/PTZCtrl/...      (Hikvision / HiLook / EZVIZ ฯลฯ)
 *   onvif     → ONVIF PTZ + Imaging     (ยี่ห้ออื่น ๆ)
 * mode 'auto' = ใช้ตามยี่ห้อที่ตรวจพบ ถ้าสั่งไม่ได้จะลอง ONVIF ต่อ
 */
class PtzController {
  constructor({ host, httpPort, user, pass, channel = 1, family = null, onvif = null, mode = 'auto' }) {
    Object.assign(this, { host, httpPort: httpPort || 80, user, pass, channel, family, onvif, mode });
    this.stopTimer = null;
    this.lastCodes = {};   // โค้ด Dahua ล่าสุดของแต่ละกลุ่ม ไว้ใช้ตอนสั่ง stop
  }

  order() {
    const m = this.mode === 'auto' ? this.family : this.mode;
    const list = [];
    if (m === 'dahua' || m === 'hikvision') list.push(m);
    if (this.onvif && !list.includes('onvif')) list.push('onvif');
    if (!list.length && this.onvif) list.push('onvif');
    return list;
  }

  http(method, path, body, ct = 'application/xml') {
    return request({
      host: this.host, port: this.httpPort, path, method, user: this.user, pass: this.pass, timeout: 4000,
      body, headers: body ? { 'Content-Type': ct } : {},
    });
  }

  /** ลองตามลำดับโปรโตคอลจนกว่าจะสำเร็จ */
  async run(fns) {
    const errors = [];
    for (const proto of this.order()) {
      const fn = fns[proto];
      if (!fn) { errors.push(`${proto}: ไม่รองรับคำสั่งนี้`); continue; }
      try { const r = await fn(); this.lastProto = proto; return { ok: true, via: proto, data: r }; }
      catch (e) { errors.push(`${proto}: ${e.message}`); }
    }
    return { ok: false, error: errors.join(' | ') || 'กล้องไม่รองรับ PTZ ผ่านโปรโตคอลที่ระบบรู้จัก' };
  }

  // ---------- Dahua ----------
  async dahuaCmd(action, code, a1 = 0, a2 = 0, a3 = 0) {
    if (action === 'start') {
      const cat = /^Zoom/.test(code) ? 'zoom' : /^Focus/.test(code) ? 'focus' : /^Iris/.test(code) ? 'iris' : /^(Up|Down|Left|Right)/.test(code) ? 'ptz' : null;
      if (cat) this.lastCodes[cat] = code;
    }
    const ch = Math.max(0, this.channel - 1);
    const r = await this.http('GET', `/cgi-bin/ptz.cgi?action=${action}&channel=${ch}&code=${code}&arg1=${a1}&arg2=${a2}&arg3=${a3}`);
    if (r.status === 401) throw new Error('รหัสผ่านไม่ถูกต้อง');
    if (r.status !== 200 || /error/i.test(r.body.slice(0, 80))) throw new Error(`HTTP ${r.status} ${r.body.slice(0, 60).trim()}`);
    return r.body;
  }
  // ---------- Hikvision ----------
  async hikPut(path, inner, root) {
    const body = `<?xml version="1.0" encoding="UTF-8"?><${root} version="2.0" xmlns="${ISAPI_NS}">${inner}</${root}>`;
    const r = await this.http('PUT', path, body);
    if (r.status === 401) throw new Error('รหัสผ่านไม่ถูกต้อง');
    if (r.status >= 300) throw new Error(`HTTP ${r.status}`);
    return r.body;
  }

  // ---------- คำสั่งระดับสูง ----------
  /** dir: up/down/left/right/upleft/upright/downleft/downright ; speed 1-8 */
  move(dir, speed = 4) {
    const d = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0], upleft: [-1, 1], upright: [1, 1], downleft: [-1, -1], downright: [1, -1] }[dir];
    if (!d) return Promise.resolve({ ok: false, error: 'ทิศทางไม่ถูกต้อง' });
    this.armWatchdog();
    const sp = Math.min(8, Math.max(1, Number(speed) || 4));
    const dahuaCode = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', upleft: 'LeftUp', upright: 'RightUp', downleft: 'LeftDown', downright: 'RightDown' }[dir];
    return this.run({
      dahua: () => this.dahuaCmd('start', dahuaCode, sp, sp, 0),
      hikvision: () => this.hikPut(`/ISAPI/PTZCtrl/channels/${this.channel}/continuous`, `<pan>${d[0] * sp * 12}</pan><tilt>${d[1] * sp * 12}</tilt>`, 'PTZData'),
      onvif: () => this.onvif.ptzMove({ pan: +(d[0] * sp / 8).toFixed(2), tilt: +(d[1] * sp / 8).toFixed(2) }),
    });
  }
  /** type: ptz|zoom|focus|iris — หยุดทุกอย่างที่กำลังเคลื่อนไหว */
  async stop(what) {
    clearTimeout(this.stopTimer);
    const tasks = {
      dahua: async () => {
        const cats = what && what !== 'all' ? [what] : ['ptz', 'zoom', 'focus', 'iris'];
        let sent = 0, lastErr;
        for (const k of cats) {
          const c = this.lastCodes[k] || (what && what !== 'all' ? this._dahuaCode(k) : null);
          if (!c) continue;
          try { await this.dahuaCmd('stop', c, 0, 0, 0); sent++; } catch (e) { lastErr = e; }
        }
        if (!sent && lastErr) throw lastErr;
      },
      hikvision: async () => {
        if (!what || what === 'all' || what === 'ptz' || what === 'zoom') await this.hikPut(`/ISAPI/PTZCtrl/channels/${this.channel}/continuous`, '<pan>0</pan><tilt>0</tilt><zoom>0</zoom>', 'PTZData');
        if (!what || what === 'all' || what === 'focus') await this.hikPut(`/ISAPI/System/Video/inputs/channels/${this.channel}/focus`, '<focus>0</focus>', 'FocusData').catch(() => {});
        if (!what || what === 'all' || what === 'iris') await this.hikPut(`/ISAPI/System/Video/inputs/channels/${this.channel}/iris`, '<iris>0</iris>', 'IrisData').catch(() => {});
      },
      onvif: async () => {
        if (!what || what === 'all' || what === 'ptz' || what === 'zoom') await this.onvif.ptzStop();
        if (what === 'focus' || what === 'all' || !what) await this.onvif.focusMove(0).catch(() => {});
      },
    };
    return this.run(tasks);
  }
  _dahuaCode(what) { return { ptz: 'Up', zoom: 'ZoomTele', focus: 'FocusNear', iris: 'IrisLarge' }[what]; }

  /** zoom/focus/iris  dir: +1 / -1 */
  lens(kind, dir, speed = 4) {
    this.armWatchdog();
    const sp = Math.min(8, Math.max(1, Number(speed) || 4));
    const dc = { zoom: ['ZoomWide', 'ZoomTele'], focus: ['FocusNear', 'FocusFar'], iris: ['IrisSmall', 'IrisLarge'] }[kind];
    if (!dc) return Promise.resolve({ ok: false, error: 'คำสั่งไม่ถูกต้อง' });
    const code = dir > 0 ? dc[1] : dc[0];
    const sign = dir > 0 ? 1 : -1;
    const fns = {
      dahua: () => this.dahuaCmd('start', code, 0, kind === 'zoom' ? sp : 0, 0),
      hikvision: () => {
        if (kind === 'zoom') return this.hikPut(`/ISAPI/PTZCtrl/channels/${this.channel}/continuous`, `<zoom>${sign * sp * 12}</zoom>`, 'PTZData');
        if (kind === 'focus') return this.hikPut(`/ISAPI/System/Video/inputs/channels/${this.channel}/focus`, `<focus>${sign * sp * 12}</focus>`, 'FocusData');
        return this.hikPut(`/ISAPI/System/Video/inputs/channels/${this.channel}/iris`, `<iris>${sign * sp * 12}</iris>`, 'IrisData');
      },
    };
    if (kind === 'zoom') fns.onvif = () => this.onvif.ptzMove({ zoom: +(sign * sp / 8).toFixed(2) });
    if (kind === 'focus') fns.onvif = () => this.onvif.focusMove(+(sign * sp / 8).toFixed(2));
    return this.run(fns);
  }

  /** กันกล้องหมุนค้าง: ถ้าไม่มีคำสั่ง stop ภายใน 10 วินาที จะสั่งหยุดเอง */
  armWatchdog() {
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => this.stop('all').catch(() => {}), 10000);
  }

  async getPresets() {
    const r = await this.run({
      dahua: async () => { throw new Error('Dahua ไม่มีคำสั่งอ่านรายชื่อ Preset'); },
      hikvision: async () => {
        const res = await this.http('GET', `/ISAPI/PTZCtrl/channels/${this.channel}/presets`);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const d = xml.parse(res.body);
        return arr(d.PTZPresetList && d.PTZPresetList.PTZPreset).filter((p) => p.enabled !== 'false').map((p) => ({ id: String(p.id), name: p.presetName || '' }));
      },
      onvif: async () => (await this.onvif.getPresets()).map((p) => ({ id: p.token, name: p.name })),
    });
    return r.ok ? { ok: true, presets: r.data, via: r.via } : r;
  }
  gotoPreset(id) {
    return this.run({
      dahua: () => this.dahuaCmd('start', 'GotoPreset', 0, id, 0),
      hikvision: async () => {
        const r = await this.http('PUT', `/ISAPI/PTZCtrl/channels/${this.channel}/presets/${id}/goto`);
        if (r.status >= 300) throw new Error(`HTTP ${r.status}`);
      },
      onvif: () => this.onvif.gotoPreset(id),
    });
  }
  setPreset(id, name) {
    return this.run({
      dahua: () => this.dahuaCmd('start', 'SetPreset', 0, id, 0),
      hikvision: () => this.hikPut(`/ISAPI/PTZCtrl/channels/${this.channel}/presets/${id}`, `<id>${id}</id><presetName>${(name || 'Preset ' + id).replace(/[<>&]/g, '')}</presetName>`, 'PTZPreset'),
      onvif: () => this.onvif.setPreset(id, name),
    });
  }
  tourStart(n) {
    return this.run({
      dahua: () => this.dahuaCmd('start', 'StartTour', n, 0, 0),
      hikvision: async () => {
        const r = await this.http('PUT', `/ISAPI/PTZCtrl/channels/${this.channel}/patrols/${n}/start`);
        if (r.status >= 300) throw new Error(`HTTP ${r.status}`);
      },
      onvif: async () => {
        const tours = await this.onvif.getTours();
        const t = tours[n - 1] || tours[0];
        if (!t) throw new Error('กล้องไม่มี Tour');
        await this.onvif.operateTour(t.token, 'Start');
      },
    });
  }
  tourStop(n) {
    return this.run({
      dahua: () => this.dahuaCmd('start', 'StopTour', n, 0, 0),
      hikvision: async () => {
        const r = await this.http('PUT', `/ISAPI/PTZCtrl/channels/${this.channel}/patrols/${n}/stop`);
        if (r.status >= 300) throw new Error(`HTTP ${r.status}`);
      },
      onvif: async () => {
        const tours = await this.onvif.getTours();
        const t = tours[n - 1] || tours[0];
        if (t) await this.onvif.operateTour(t.token, 'Stop');
      },
    });
  }
  dispose() { clearTimeout(this.stopTimer); }
}

module.exports = { PtzController };
