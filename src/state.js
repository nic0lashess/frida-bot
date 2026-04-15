const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'state.json');

const DEFAULT = {
  conversation: 'IDLE',           // IDLE | SLOTS_PROPOSED | BOOKING | PAYMENT_LINK_SENT
  proposedSlots: [],              // [{ time, available }]
  proposedAt: null,
  selectedSlot: null,
  paymentUrl: null,
  paymentSentAt: null,
  lastSeenSlots: [],              // pour ne pas re-notifier
};

function load() {
  if (!fs.existsSync(FILE)) return { ...DEFAULT };
  try {
    return { ...DEFAULT, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT };
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

function reset() {
  save({ ...DEFAULT, lastSeenSlots: load().lastSeenSlots });
}

module.exports = { load, save, reset, DEFAULT };
