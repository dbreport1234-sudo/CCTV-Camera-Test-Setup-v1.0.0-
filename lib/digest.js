'use strict';
const crypto = require('crypto');
const { md5 } = require('./util');

/** แยก WWW-Authenticate (อาจมีหลายบรรทัด/หลายแบบ) */
function parseChallenges(headerVal) {
  const list = Array.isArray(headerVal) ? headerVal : headerVal ? [headerVal] : [];
  const out = [];
  for (const h of list) {
    // บางกล้องส่ง Basic และ Digest ในบรรทัดเดียว
    const parts = String(h).split(/,\s*(?=(?:Digest|Basic)\s)/i);
    for (const p of parts) {
      const m = p.match(/^\s*(Digest|Basic)\s*(.*)$/i);
      if (!m) continue;
      const scheme = m[1].toLowerCase();
      const params = {};
      const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
      let x;
      while ((x = re.exec(m[2]))) params[x[1].toLowerCase()] = x[2] !== undefined ? x[2] : x[3];
      out.push({ scheme, params });
    }
  }
  // ให้ Digest มาก่อน
  out.sort((a, b) => (a.scheme === 'digest' ? -1 : 1) - (b.scheme === 'digest' ? -1 : 1));
  return out;
}

let ncCounter = 0;
function buildAuthorization(challenges, { method, uri, user, pass }) {
  const ch = challenges[0];
  if (!ch) return null;
  if (ch.scheme === 'basic') {
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }
  const p = ch.params;
  const realm = p.realm || '';
  const nonce = p.nonce || '';
  const qop = p.qop ? String(p.qop).split(',').map((s) => s.trim()).find((s) => s === 'auth') || null : null;
  const algo = (p.algorithm || 'MD5').toUpperCase();
  let ha1 = md5(`${user}:${realm}:${pass}`);
  const cnonce = crypto.randomBytes(8).toString('hex');
  if (algo === 'MD5-SESS') ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  let response, extra = '';
  if (qop) {
    const nc = (++ncCounter).toString(16).padStart(8, '0');
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    extra = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"${extra}`;
  if (p.opaque) h += `, opaque="${p.opaque}"`;
  if (p.algorithm) h += `, algorithm=${p.algorithm}`;
  return h;
}

module.exports = { parseChallenges, buildAuthorization };
