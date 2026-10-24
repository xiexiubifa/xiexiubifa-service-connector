'use strict';
// The in-memory store, kept in one JSON file between restarts of a local server (development only; one process).
// Writes are coalesced and saved with write-to-temp + rename, so the file is never half written.
const fs = require('node:fs');
const path = require('node:path');
const { createMemoryStore } = require('./store-memory.cjs');

function createFileStore(file) {
  let timer = null;
  const save = (tables) => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const data = {};
      for (const [name, rows] of tables) data[name] = Object.fromEntries(rows);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(temp, file);
    }, 50);
    timer.unref?.();
  };
  const store = createMemoryStore({ onChange: save });
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [name, rows] of Object.entries(data)) store._tables.set(name, new Map(Object.entries(rows)));
  }
  return store;
}

module.exports = { createFileStore };
