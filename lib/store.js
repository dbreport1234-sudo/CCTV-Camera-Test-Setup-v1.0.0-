'use strict';
const fs = require('fs');
const path = require('path');

/** เก็บรายการกล้องและการตั้งค่าเป็นไฟล์ JSON (อ่านง่าย สำรองง่าย) */
class Store {
  constructor(dataDir, defaults) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'cameras.json');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'thumbs'), { recursive: true });
    this.data = { nextId: 1, cameras: [], settings: { ...defaults } };
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...d, settings: { ...defaults, ...(d.settings || {}) } };
    } catch {}
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  get settings() { return this.data.settings; }
  setSettings(p) { Object.assign(this.data.settings, p); this.save(); return this.data.settings; }
  list() { return this.data.cameras.map(({ pass, ...c }) => ({ ...c, hasPass: !!pass })); }
  get(id) { return this.data.cameras.find((c) => c.id === Number(id)); }
  add(c) {
    const cam = { id: this.data.nextId++, createdAt: new Date().toISOString(), ...c };
    this.data.cameras.push(cam); this.save(); return cam;
  }
  update(id, patch) {
    const c = this.get(id); if (!c) return null;
    Object.assign(c, patch); this.save(); return c;
  }
  remove(id) {
    const n = this.data.cameras.length;
    this.data.cameras = this.data.cameras.filter((c) => c.id !== Number(id));
    this.save();
    try { fs.unlinkSync(this.thumbPath(id)); } catch {}
    return this.data.cameras.length < n;
  }
  thumbPath(id) { return path.join(this.dir, 'thumbs', `cam-${Number(id)}.jpg`); }
}

module.exports = { Store };
