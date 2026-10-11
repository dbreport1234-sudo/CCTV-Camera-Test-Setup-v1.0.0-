'use strict';
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { once } = require('./httpclient');
const { arr } = require('./util');

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });

const NS = {
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  timg: 'http://www.onvif.org/ver20/imaging/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
};

const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

class Onvif {
  /** @param {{host:string, port:number, user:string, pass:string}} o */
  constructor(o) {
    Object.assign(this, { host: o.host, port: o.port, user: o.user || '', pass: o.pass || '' });
    this.offsetMs = 0;               // ความต่างของนาฬิกากล้องกับเครื่องเรา (กล้องเก่าเวลาเพี้ยนบ่อย → auth ไม่ผ่าน)
    this.deviceUrl = '/onvif/device_service';
    this.xaddr = {};                 // media / ptz / imaging
    this.profiles = [];
    this.ready = false;
  }

  header(withAuth) {
    if (!withAuth || !this.user) return '';
    const nonce = crypto.randomBytes(16);
    const created = new Date(Date.now() + this.offsetMs).toISOString().replace(/\.\d+Z$/, 'Z');
    const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(this.pass)])).digest('base64');
    return `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${esc(this.user)}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password><Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce><Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created></UsernameToken></Security></s:Header>`;
  }

  /** เรียก SOAP; url = path หรือ URL เต็มของ service */
  async call(url, action, ns, bodyInner, { auth = true, timeout = 5000 } = {}) {
    let host = this.host, port = this.port, path = url;
    if (/^https?:\/\//i.test(url)) {
      const u = new URL(url);
      host = this.host; // ใช้ IP ที่ช่างกรอก (บางกล้องตอบ IP ภายในที่เข้าไม่ถึง)
      port = Number(u.port || 80);
      path = u.pathname + u.search;
    }
    const xml = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="${NS.tt}" xmlns:${ns}="${NS[ns]}">${this.header(auth)}<s:Body>${bodyInner}</s:Body></s:Envelope>`;
    const res = await once({
      host, port, path, method: 'POST', timeout, body: xml,
      headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${NS[ns]}/${action}"` },
    });
    let doc = null;
    try { doc = parser.parse(res.body); } catch {}
    const env = doc && doc.Envelope;
    const body = env && env.Body;
    const fault = body && body.Fault;
    if (res.status === 401 || (fault && /NotAuthorized|Sender not authorized|authority failure/i.test(JSON.stringify(fault)))) {
      const e = new Error('ONVIF: ชื่อผู้ใช้/รหัสผ่านไม่ถูกต้อง'); e.code = 'AUTH'; throw e;
    }
    if (fault) { const e = new Error('ONVIF fault: ' + JSON.stringify(fault).slice(0, 200)); e.code = 'FAULT'; throw e; }
    if (!body) { const e = new Error(`ONVIF: ตอบกลับไม่ถูกต้อง (HTTP ${res.status})`); e.code = 'BAD'; throw e; }
    return body;
  }

  /** ตรวจว่ามี ONVIF ที่พอร์ตนี้ไหม + ตั้งค่า offset เวลา */
  async probe() {
    for (const path of ['/onvif/device_service', '/onvif/device', '/device_service']) {
      try {
        const body = await this.call(path, 'GetSystemDateAndTime', 'tds', '<tds:GetSystemDateAndTime/>', { auth: false, timeout: 2500 });
        const r = body.GetSystemDateAndTimeResponse;
        if (!r) continue;
        this.deviceUrl = path;
        const u = r.SystemDateAndTime && r.SystemDateAndTime.UTCDateTime;
        if (u && u.Date && u.Time) {
          const t = Date.UTC(+u.Date.Year, +u.Date.Month - 1, +u.Date.Day, +u.Time.Hour, +u.Time.Minute, +u.Time.Second);
          if (!Number.isNaN(t)) this.offsetMs = t - Date.now();
        }
        return true;
      } catch (e) { if (e.code === 'AUTH') { this.deviceUrl = path; return true; } }
    }
    return false;
  }

  async getDeviceInformation() {
    const b = await this.call(this.deviceUrl, 'GetDeviceInformation', 'tds', '<tds:GetDeviceInformation/>');
    const r = b.GetDeviceInformationResponse || {};
    return { manufacturer: r.Manufacturer, model: r.Model, firmware: r.FirmwareVersion, serial: r.SerialNumber };
  }

  async loadServices() {
    try {
      const b = await this.call(this.deviceUrl, 'GetCapabilities', 'tds', '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');
      const c = (b.GetCapabilitiesResponse || {}).Capabilities || {};
      this.xaddr.media = c.Media && c.Media.XAddr;
      this.xaddr.ptz = c.PTZ && c.PTZ.XAddr;
      this.xaddr.imaging = c.Imaging && c.Imaging.XAddr;
    } catch (e) { if (e.code === 'AUTH') throw e; }
    this.xaddr.media = this.xaddr.media || this.deviceUrl.replace('device', 'media').replace('device_service', 'media_service');
    this.xaddr.media = this.xaddr.media || '/onvif/media_service';
    this.xaddr.ptz = this.xaddr.ptz || '/onvif/ptz_service';
    this.xaddr.imaging = this.xaddr.imaging || '/onvif/imaging_service';
  }

  async loadProfiles() {
    const b = await this.call(this.xaddr.media, 'GetProfiles', 'trt', '<trt:GetProfiles/>');
    const list = arr((b.GetProfilesResponse || {}).Profiles);
    this.profiles = list.map((p) => {
      const v = p.VideoEncoderConfiguration || {};
      const res = v.Resolution || {};
      return {
        token: p['@_token'], name: p.Name,
        encoding: v.Encoding, width: +res.Width || 0, height: +res.Height || 0,
        fps: v.RateControl && +v.RateControl.FrameRateLimit || 0,
        videoSource: p.VideoSourceConfiguration && p.VideoSourceConfiguration.SourceToken,
        hasPtz: !!p.PTZConfiguration,
      };
    }).filter((p) => p.token);
    return this.profiles;
  }

  async getStreamUri(token) {
    const body = `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${esc(token)}</trt:ProfileToken></trt:GetStreamUri>`;
    const b = await this.call(this.xaddr.media, 'GetStreamUri', 'trt', body);
    const uri = (((b.GetStreamUriResponse || {}).MediaUri) || {}).Uri;
    return uri ? String(uri) : null;
  }

  /** ดึงทุก profile พร้อม RTSP URI และจัด main/sub ตามความละเอียด */
  async discoverStreams() {
    if (!this.profiles.length) await this.loadProfiles();
    const out = [];
    for (const p of this.profiles) {
      try { out.push({ ...p, uri: await this.getStreamUri(p.token) }); } catch { /* ข้าม profile ที่ใช้ไม่ได้ */ }
    }
    const video = out.filter((p) => p.uri && p.encoding !== 'G711' && p.encoding !== 'AAC');
    const byRes = [...video].sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return { all: video, main: byRes[0] || null, sub: byRes.length > 1 ? byRes[byRes.length - 1] : null };
  }

  ptzProfile() { return (this.profiles.find((p) => p.hasPtz) || this.profiles[0] || {}).token; }

  // ---------- PTZ ----------
  async ptzMove({ pan = 0, tilt = 0, zoom = 0 }) {
    const tok = this.ptzProfile();
    let vel = '';
    if (pan || tilt) vel += `<tt:PanTilt x="${pan}" y="${tilt}"/>`;
    if (zoom) vel += `<tt:Zoom x="${zoom}"/>`;
    await this.call(this.xaddr.ptz, 'ContinuousMove', 'tptz', `<tptz:ContinuousMove><tptz:ProfileToken>${esc(tok)}</tptz:ProfileToken><tptz:Velocity>${vel}</tptz:Velocity></tptz:ContinuousMove>`);
  }
  async ptzStop() {
    const tok = this.ptzProfile();
    await this.call(this.xaddr.ptz, 'Stop', 'tptz', `<tptz:Stop><tptz:ProfileToken>${esc(tok)}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`);
  }
  async getPresets() {
    const tok = this.ptzProfile();
    const b = await this.call(this.xaddr.ptz, 'GetPresets', 'tptz', `<tptz:GetPresets><tptz:ProfileToken>${esc(tok)}</tptz:ProfileToken></tptz:GetPresets>`);
    return arr((b.GetPresetsResponse || {}).Preset).map((p) => ({ token: p['@_token'], name: p.Name || '' }));
  }
  async gotoPreset(token) {
    await this.call(this.xaddr.ptz, 'GotoPreset', 'tptz', `<tptz:GotoPreset><tptz:ProfileToken>${esc(this.ptzProfile())}</tptz:ProfileToken><tptz:PresetToken>${esc(token)}</tptz:PresetToken></tptz:GotoPreset>`);
  }
  async setPreset(token, name) {
    const tk = token !== undefined && token !== null ? `<tptz:PresetToken>${esc(token)}</tptz:PresetToken>` : '';
    await this.call(this.xaddr.ptz, 'SetPreset', 'tptz', `<tptz:SetPreset><tptz:ProfileToken>${esc(this.ptzProfile())}</tptz:ProfileToken>${name ? `<tptz:PresetName>${esc(name)}</tptz:PresetName>` : ''}${tk}</tptz:SetPreset>`);
  }
  async getTours() {
    const b = await this.call(this.xaddr.ptz, 'GetPresetTours', 'tptz', `<tptz:GetPresetTours><tptz:ProfileToken>${esc(this.ptzProfile())}</tptz:ProfileToken></tptz:GetPresetTours>`);
    return arr((b.GetPresetToursResponse || {}).PresetTour).map((t) => ({ token: t['@_token'], name: t.Name || '' }));
  }
  async operateTour(token, op) {
    await this.call(this.xaddr.ptz, 'OperatePresetTour', 'tptz', `<tptz:OperatePresetTour><tptz:ProfileToken>${esc(this.ptzProfile())}</tptz:ProfileToken><tptz:PresetTourToken>${esc(token)}</tptz:PresetTourToken><tptz:Operation>${op}</tptz:Operation></tptz:OperatePresetTour>`);
  }
  async focusMove(speed) {
    const src = (this.profiles.find((p) => p.videoSource) || {}).videoSource || '';
    if (!speed) return this.call(this.xaddr.imaging, 'Stop', 'timg', `<timg:Stop><timg:VideoSourceToken>${esc(src)}</timg:VideoSourceToken></timg:Stop>`);
    return this.call(this.xaddr.imaging, 'Move', 'timg', `<timg:Move><timg:VideoSourceToken>${esc(src)}</timg:VideoSourceToken><timg:Focus><tt:Continuous><tt:Speed>${speed}</tt:Speed></tt:Continuous></timg:Focus></timg:Move>`);
  }
}

module.exports = { Onvif };
