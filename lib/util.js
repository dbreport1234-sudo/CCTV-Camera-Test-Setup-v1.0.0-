'use strict';
const net = require('net');
const crypto = require('crypto');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ตรวจว่าพอร์ต TCP เปิดอยู่หรือไม่ */
function tcpCheck(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (ok) => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

/** รันงานแบบจำกัดจำนวนพร้อมกัน */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  const run = async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** ซ่อนรหัสผ่านใน URL เพื่อแสดงผล */
function maskUrl(u) {
  return String(u || '')
    .replace(/(\/\/[^:/@]+):[^@]*@/, '$1:••••••@')
    .replace(/(password=)[^&?]*/i, '$1••••••');
}

const pad = (n, l = 2) => String(n).padStart(l, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function safeName(s) {
  return String(s || 'camera').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'camera';
}
const arr = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

module.exports = { md5, sleep, tcpCheck, pool, maskUrl, stamp, safeName, pad, arr };
