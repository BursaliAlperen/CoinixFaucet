'use strict';
const crypto = require('node:crypto');

function encodePath(path) {
  return Buffer.from(String(path || '').replace(/^\\/+|\\/+$/g, '')).toString('base64url') || 'root';
}
function clone(value) { return value === undefined ? null : JSON.parse(JSON.stringify(value)); }
class Snapshot {
  constructor(key, value) { this.key = key; this._value = value; }
  val() { return clone(this._value); }
  exists() { return this._value !== null && this._value !== undefined; }
  forEach(callback) {
    if (!this._value || typeof this._value !== 'object') return false;
    for (const [key, value] of Object.entries(this._value)) {
      if (callback(new Snapshot(key, value)) === true) return true;
    }
    return false;
  }
}
class FirestoreCompat {
  constructor(firestore) { this.db = firestore; this.collection = firestore.collection('appData'); }
  ref(path = '') { return new Ref(this, String(path).replace(/^\\/+|\\/+$/g, '')); }
  async read(path) {
    const id = encodePath(path);
    const exact = await this.collection.doc(id).get();
    let root = exact.exists ? clone(exact.get('value')) : null;
    const prefix = path ? path + '/' : '';
    const descendants = await this.collection.where('path', '>=', prefix).where('path', '<', prefix + '\\uf8ff').get();
    for (const doc of descendants.docs) {
      const childPath = doc.get('path');
      if (!childPath || childPath === path) continue;
      const parts = childPath.slice(prefix.length).split('/');
      if (!parts.length || parts.some(part => !part)) continue;
      if (root === null || typeof root !== 'object') root = {};
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = clone(doc.get('value'));
    }
    return root;
  }
  async write(path, value) {
    const doc = this.collection.doc(encodePath(path));
    if (value === null || value === undefined) return doc.delete();
    return doc.set({ path, value: clone(value), updatedAt: Date.now() });
  }
  async update(path, patch) {
    const current = await this.read(path) || {};
    return this.write(path, { ...current, ...clone(patch) });
  }
  async remove(path) {
    const prefix = path ? path + '/' : '';
    const batch = this.db.batch();
    const exact = this.collection.doc(encodePath(path));
    batch.delete(exact);
    const children = await this.collection.where('path', '>=', prefix).where('path', '<', prefix + '\\uf8ff').get();
    children.docs.forEach(doc => batch.delete(doc.ref));
    return batch.commit();
  }
  async transact(path, updater) {
    const doc = this.collection.doc(encodePath(path));
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(doc);
      const current = snap.exists ? clone(snap.get('value')) : null;
      const next = updater(clone(current));
      if (next === undefined) return { committed: false, snapshot: new Snapshot(path.split('/').pop(), current) };
      if (next === null) tx.delete(doc);
      else tx.set(doc, { path, value: clone(next), updatedAt: Date.now() });
      return { committed: true, snapshot: new Snapshot(path.split('/').pop(), next) };
    });
  }
}
class Ref {
  constructor(adapter, path, filters = {}) { this.adapter = adapter; this.path = path; this.filters = filters; this.key = path.split('/').pop() || null; }
  child(segment) { return new Ref(this.adapter, [this.path, segment].filter(Boolean).join('/')); }
  push(value) {
    const key = crypto.randomBytes(12).toString('hex');
    const ref = this.child(key);
    if (value !== undefined) ref.set(value).catch(error => console.warn('[firestore-push]', error.message));
    return ref;
  }
  set(value) { return this.adapter.write(this.path, value); }
  update(value) { return this.adapter.update(this.path, value); }
  remove() { return this.adapter.remove(this.path); }
  transaction(updater) { return this.adapter.transact(this.path, updater); }
  once() {
    return this.adapter.read(this.path).then(value => {
      if (!Object.keys(this.filters).length || !value || typeof value !== 'object') return new Snapshot(this.key, value);
      let entries = Object.entries(value);
      if (this.filters.child) entries = entries.filter(([, v]) => v && v[this.filters.child] === this.filters.equal);
      if (this.filters.limit) entries = entries.slice(-this.filters.limit);
      if (this.filters.desc) entries.sort((a,b) => Number(b[1]?.[this.filters.child] || 0) - Number(a[1]?.[this.filters.child] || 0));
      else if (this.filters.child) entries.sort((a,b) => Number(a[1]?.[this.filters.child] || 0) - Number(b[1]?.[this.filters.child] || 0));
      return new Snapshot(this.key, Object.fromEntries(entries));
    });
  }
  orderByChild(child) { return new Ref(this.adapter, this.path, { ...this.filters, child, desc: false }); }
  equalTo(equal) { return new Ref(this.adapter, this.path, { ...this.filters, equal }); }
  limitToLast(limit) { return new Ref(this.adapter, this.path, { ...this.filters, limit: Number(limit) }); }
}
module.exports = { FirestoreCompat };
