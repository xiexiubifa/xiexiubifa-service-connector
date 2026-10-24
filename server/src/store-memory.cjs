'use strict';
// The storage interface the service uses, and an in-memory implementation (tests, local runs).
//
//   get(collection, id)                       → document (with _id) or null
//   put(collection, id, document)             → document
//   patch(collection, id, fields)             → document after a shallow merge, or null when it does not exist
//   remove(collection, id)
//   find(collection, where, { limit, orderBy, direction })   equality filters only
//   expired(collection, before, limit)        → documents whose numeric expiresAt is earlier than `before`
//   transaction(async (tx) => …)              tx: get / put / patch / remove, applied together or not at all
//
// A deployment supplies its own implementation with the same calls (for example, on its cloud database).
const clone = (value) => (value === undefined || value === null ? value : structuredClone(value));
const DELETED = Symbol('deleted');

function createMemoryStore({ onChange } = {}) {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const changed = () => onChange?.(tables);
  let chain = Promise.resolve();

  const base = {
    async get(collection, id) {
      const doc = table(collection).get(id);
      return doc ? { ...clone(doc), _id: id } : null;
    },
    async put(collection, id, doc) {
      const { _id, ...rest } = doc;
      table(collection).set(id, clone(rest));
      changed();
      return { ...clone(rest), _id: id };
    },
    async patch(collection, id, fields) {
      const rows = table(collection);
      if (!rows.has(id)) return null;
      const { _id, ...rest } = fields;
      const next = { ...rows.get(id), ...clone(rest) };
      rows.set(id, next);
      changed();
      return { ...clone(next), _id: id };
    },
    async remove(collection, id) {
      table(collection).delete(id);
      changed();
    },
    async find(collection, where = {}, { limit = 100, orderBy, direction = 'asc' } = {}) {
      let rows = [...table(collection)].map(([id, doc]) => ({ ...clone(doc), _id: id }))
        .filter((doc) => Object.entries(where).every(([key, value]) => doc[key] === value));
      if (orderBy) rows.sort((a, b) => (a[orderBy] > b[orderBy] ? 1 : a[orderBy] < b[orderBy] ? -1 : 0) * (direction === 'desc' ? -1 : 1));
      return rows.slice(0, limit);
    },
    async expired(collection, before, limit = 50) {
      return [...table(collection)].filter(([, doc]) => typeof doc.expiresAt === 'number' && doc.expiresAt < before)
        .slice(0, limit).map(([id, doc]) => ({ ...clone(doc), _id: id }));
    },
    // One transaction at a time; its writes are staged and applied only when the work finishes without an error.
    transaction(work) {
      const run = chain.then(async () => {
        const staged = new Map();
        const key = (c, id) => c + '\u0000' + id;
        const read = (c, id) => {
          const k = key(c, id);
          if (staged.has(k)) { const v = staged.get(k); return v === DELETED ? null : clone(v); }
          const doc = table(c).get(id);
          return doc ? clone(doc) : null;
        };
        const tx = {
          async get(c, id) { const doc = read(c, id); return doc ? { ...doc, _id: id } : null; },
          async put(c, id, doc) { const { _id, ...rest } = doc; staged.set(key(c, id), clone(rest)); return { ...clone(rest), _id: id }; },
          async patch(c, id, fields) {
            const doc = read(c, id);
            if (!doc) return null;
            const { _id, ...rest } = fields;
            const next = { ...doc, ...clone(rest) };
            staged.set(key(c, id), next);
            return { ...clone(next), _id: id };
          },
          async remove(c, id) { staged.set(key(c, id), DELETED); }
        };
        const result = await work(tx);
        for (const [k, value] of staged) {
          const [c, id] = k.split('\u0000');
          if (value === DELETED) table(c).delete(id); else table(c).set(id, value);
        }
        if (staged.size) changed();
        return result;
      });
      chain = run.catch(() => {});
      return run;
    }
  };
  // For tests and the local file store: the raw tables.
  base._tables = tables;
  return base;
}

module.exports = { createMemoryStore };
