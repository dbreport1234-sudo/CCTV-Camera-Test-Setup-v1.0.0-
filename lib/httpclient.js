'use strict';
const http = require('http');
const { parseChallenges, buildAuthorization } = require('./digest');

function once({ host, port, path, method = 'GET', headers = {}, body, timeout = 4000 }) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body) : null;
    const req = http.request({
      host, port, path, method, agent: false, timeout,
      insecureHTTPParser: true, // กล้องรุ่นเก่าตอบ HTTP แบบไม่เป็นมาตรฐาน
      headers: { 'User-Agent': 'CCTV-Tech/1.0', Connection: 'close', ...(data ? { 'Content-Length': data.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size < 2_000_000) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * ส่ง HTTP request โดยจัดการ Digest/Basic ให้อัตโนมัติ (ถ้ามี user)
 * คืนค่า { status, headers, body, authed } หรือโยน error ถ้าเชื่อมต่อไม่ได้
 */
async function request(opts) {
  const { user, pass } = opts;
  let res = await once(opts);
  if (res.status === 401 && user !== undefined && user !== '') {
    const ch = parseChallenges(res.headers['www-authenticate']);
    const authz = buildAuthorization(ch, { method: opts.method || 'GET', uri: opts.path, user, pass: pass || '' });
    if (authz) {
      res = await once({ ...opts, headers: { ...(opts.headers || {}), Authorization: authz } });
      res.authed = true;
    }
  }
  return res;
}

module.exports = { request, once };
