'use strict';
const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const { tcpCheck, pool } = require('./util');
const { fingerprint, BRAND_LABEL, normalizeBrand } = require('./brands');

const SCAN_PORTS = [554, 8554, 80, 8080, 8000, 8899, 37777, 34567];
const STRONG = new Set([554, 8554, 37777, 34567]);

function localNets() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      if (/^169\.254\./.test(n.address)) continue;
      const base = n.address.split('.').slice(0, 3).join('.');
      out.push({ iface: name, address: n.address, base });
    }
  }
  return out;
}

function discoverOnvif(nets, timeoutMs, onFound) {
  return new Promise((resolve) => {
    const socks = [];
    const probe = `<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:${crypto.randomUUID()}</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;
    for (const n of nets) {
      try {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.on('error', () => {});
        s.on('message', (msg, rinfo) => {
          const t = msg.toString();
          const scopes = (t.match(/onvif:\/\/www\.onvif\.org\/[^\s<]+/g) || []).map((x) => decodeURIComponent(x.split('/').slice(3).join('/')));
          const name = (scopes.find((x) => x.startsWith('name/')) || '').slice(5);
          const hw = (scopes.find((x) => x.startsWith('hardware/')) || '').slice(9);
          onFound({ ip: rinfo.address, name, hardware: hw });
        });
        s.bind(0, n.address, () => {
          try { s.setMulticastInterface(n.address); s.send(Buffer.from(probe), 3702, '239.255.255.250'); } catch {}
        });
        socks.push(s);
      } catch {}
    }
    setTimeout(() => { for (const s of socks) { try { s.close(); } catch {} } resolve(); }, timeoutMs);
  });
}

/**
 * สแกนวงแลนเพื่อหากล้อง: ตรวจพอร์ตทั้ง /24 + ONVIF WS-Discovery
 * onEvent({type:'progress'|'found', ...})
 */
async function scan(onEvent, { signal } = {}) {
  const nets = localNets();
  if (!nets.length) throw new Error('ไม่พบการเชื่อมต่อเครือข่ายในเครื่องนี้ (ต่อสายแลน/WiFi ก่อน)');
  const found = new Map();
  const upsert = (ip, patch) => {
    const cur = found.get(ip) || { ip, ports: [], brand: null, brandLabel: '', name: '', model: '' };
    Object.assign(cur, patch, { ports: patch.ports || cur.ports });
    found.set(ip, cur);
    onEvent({ type: 'found', device: { ...cur } });
  };

  // ONVIF multicast รันขนานกับการสแกนพอร์ต
  const dis = discoverOnvif(nets, 6000, (d) => {
    const nb = normalizeBrand(`${d.name} ${d.hardware}`);
    const prev = found.get(d.ip);
    upsert(d.ip, { name: d.name, model: d.hardware, onvif: true, brand: (prev && prev.brand) || nb, brandLabel: (prev && prev.brandLabel) || (nb ? BRAND_LABEL[nb] : '') });
  });

  const hosts = [];
  for (const n of nets) for (let i = 1; i <= 254; i++) { const ip = `${n.base}.${i}`; if (ip !== n.address) hosts.push(ip); }
  const uniq = [...new Set(hosts)];
  const hits = new Map();
  let done = 0;
  onEvent({ type: 'progress', done: 0, total: uniq.length });
  await pool(uniq, 128, async (ip) => {
    if (signal && signal.aborted) return;
    const open = [];
    await Promise.all(SCAN_PORTS.map(async (p) => { if (await tcpCheck(ip, p, 700)) open.push(p); }));
    done++;
    if (done % 8 === 0 || done === uniq.length) onEvent({ type: 'progress', done, total: uniq.length });
    if (open.some((p) => STRONG.has(p))) { hits.set(ip, open.sort((a, b) => a - b)); upsert(ip, { ports: hits.get(ip) }); }
  });

  // ระบุยี่ห้อของเครื่องที่น่าจะเป็นกล้อง
  await pool([...hits.keys()], 6, async (ip) => {
    const httpPorts = hits.get(ip).filter((p) => [80, 8080, 8000, 8899].includes(p));
    try {
      const fp = httpPorts.length ? await fingerprint(ip, httpPorts, 1800) : { brand: null };
      const cur = found.get(ip) || {};
      const brand = fp.brand || cur.brand || (hits.get(ip).includes(37777) ? 'dahua' : hits.get(ip).includes(34567) ? 'xm' : null);
      if (brand) upsert(ip, { brand, brandLabel: BRAND_LABEL[brand] || brand });
    } catch {}
  });
  await dis;
  onEvent({ type: 'progress', done: uniq.length, total: uniq.length });
  return [...found.values()].sort((a, b) => a.ip.split('.').map(Number).reduce((x, y) => x * 256 + y, 0) - b.ip.split('.').map(Number).reduce((x, y) => x * 256 + y, 0));
}

module.exports = { scan, localNets };
