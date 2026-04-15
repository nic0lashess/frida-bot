const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'purchases.json');

function load() {
  if (!fs.existsSync(FILE)) return [];
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return []; }
}

function save(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function add(entry) {
  const list = load();
  list.push({ ...entry, createdAt: new Date().toISOString() });
  save(list);
}

function remove(id) {
  const list = load().filter(p => p.id !== id);
  save(list);
}

module.exports = { load, save, add, remove };
