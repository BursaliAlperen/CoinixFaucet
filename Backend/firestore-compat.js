'use strict';
const crypto = require('node:crypto');

function normalizePath(path) {
  return String(path || '').split('/').filter(Boolean).join('/');
}
function encodePath(path) {
  return Buffer.from(normalizePath(path)).toString('base64url') || 'root';
}
function clone(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}
function mergeTree(root, parentPath, docs) {
  let value = root;
  const prefix = parentPath ? parentPath + '/' : '';
  for (const doc of docs) {
    const childPath = doc.get('path');
    if (!childPath || childPath === parentPath || !childPath.startsWith(prefix)) continue;
    const parts = childPath.slice(prefix.length).split('/');
    if (!parts.length || parts.some(part => !part)) continue;
    if (value === null || typeof value !== 'object') value = {};
    let node = value;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = clone(doc.get('value'));
  }
  return value;
}
class Snapshot {
  constructor(key, value) { this.key = key; this._value = value; }
  val() { return clone(this._value); }
  exists() { return this._value !== null && this._value !== undefined; }
  child(name) { return new Snapshot(String(name), this._value && this._value[name]); }
  forEach(callback) {
    if (!this._value || typeof this._value !== 'object') return false;
    for (const [key, value] of Object.entries(this._value)) {
      if (callback(new Snapshot(key, value)) === true) return true;
    }
    return false;
  }
}
class FirestoreCompat {
  constructor(firestore) {
    this.db = firestore;
    this.collection = firestore.collection('appData');
  }
  ref(path = '') { return new Ref(this, normalizePath(path)); }
  async read(path) {
    const normalized = normalizePath(path);
    const exact = await this.collection.doc(encodePath(normalized)).get();
    const root = exact.exists ? clone(exact.get('value')) : null;
    const prefix = normalized ? normalized + '/' : '';
    const descendants = await this.collection.where('path', '>=', prefix).where('path', '<', prefix + '\uf8ff').get();
    return mergeTree(root, normalized, descendants.docs);
  }
  async write(path, value) {
    const normalized = normalizePath(path);
    const doc = this.collection.doc(encodePath(normalized));
    if (value === null || value === undefined) return doc.delete();
    return doc.set({ path: normalized, value: clone(value), updatedAt: Date.now() });
  }
  async update(path, patch) {
    const current = await this.read(path) || {};
    return this.write(path, { ...current, ...clone(patch) });
  }
  async remove(path) {
    const normalized = normalizePath(path);
    const prefix = normalized ? normalized + '/' : '';
    const batch = this.db.batch();
    batch.delete(this.collection.doc(encodePath(normalized)));
    const children = await this.collection.where('path', '>=', prefix).where('path', '<', prefix + '\uf8ff').get();
    children.docs.forEach(doc => batch.delete(doc.ref));
    return batch.commit();
  }
  async transact(path, updater) {
    const normalized = normalizePath(path);
    const doc = this.collection.doc(encodePath(normalized));
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(doc);
      const prefix = normalized ? normalized + '/' : '';
      const query = this.collection.where('path', '>=', prefix).where('path', '<', prefix + '\uf8ff');
      const descendants = await tx.get(query);
      const root = snap.exists ? clone(snap.get('value')) : null;
      const current = mergeTree(root, normalized, descendants.docs);
      const next = updater(clone(current));
      if (next === undefined) return { committed: false, snapshot: new Snapshot(normalized.split('/').pop(), current) };
      if (next === null) tx.delete(doc);
      else tx.set(doc, { path: normalized, value: clone(next), updatedAt: Date.now() });
      return { committed: true, snapshot: new Snapshot(normalized.split('/').pop(), next) };
    });
  }
}
class Ref {
  constructor(adapter, path, filters = {}) {
    this.adapter = adapter;
    this.path = path;
    this.filters = filters;
    this.key = path.split('/').pop() || null;
  }
  child(segment) { return new Ref(this.adapter, normalizePath(this.path + '/' + segment)); }
  push(value) {
    const ref = this.child(crypto.randomBytes(12).toString('hex'));
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
      if (this.filters.child) entries = entries.filter(([, item]) => item && (this.filters.equal === undefined || String(item[this.filters.child]) === String(this.filters.equal)));
      if (this.filters.child) entries.sort((a, b) => Number(a[1]?.[this.filters.child] || 0) - Number(b[1]?.[this.filters.child] || 0));
      if (this.filters.limit) entries = entries.slice(-this.filters.limit);
      return new Snapshot(this.key, Object.fromEntries(entries));
    });
  }
  orderByChild(child) { return new Ref(this.adapter, this.path, { ...this.filters, child }); }
  equalTo(equal) { return new Ref(this.adapter, this.path, { ...this.filters, equal }); }
  limitToLast(limit) { return new Ref(this.adapter, this.path, { ...this.filters, limit: Number(limit) }); }
}
module.exports = { FirestoreCompat };
