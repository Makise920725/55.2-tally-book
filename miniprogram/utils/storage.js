const STORAGE_KEY = 'p5519';
const SCHEMA_VERSION = 4;

function seed() { return require('../domain/plan').createInitialState(); }

function migrate(state) {
  const { CONFIG, derivePeriods } = require('../domain/plan');
  const next = { ...state };
  next.config = { ...CONFIG, ...(next.config || {}), scenario: (next.config && next.config.scenario) || '中' };
  if (!next.schemaVersion) next.schemaVersion = 1;
  if (!next.ledger) next.ledger = { expenses: [], transfers: [], adjusts: [] };
  next.ledger.expenses = next.ledger.expenses || [];
  next.ledger.transfers = next.ledger.transfers || [];
  next.ledger.adjusts = next.ledger.adjusts || [];
  next.ledger.specials = next.ledger.specials || [];
  next.categories = next.categories || require('../domain/plan').DEFAULT_CATEGORIES;
  next.daySlots = next.daySlots || {};
  next.paydaySteps = next.paydaySteps || {};
  next.executedPaydays = next.executedPaydays || {};
  next.periods = next.periods || derivePeriods({ dailyBudget: next.config.dailyBudget });
  next.mode = next.mode || 'daily';
  next.openingBalances = next.openingBalances || { BANK1: 0, POOL2: 0, POCKET3: 0, BILL: 0, OUT: 0 };
  next.schemaVersion = SCHEMA_VERSION;
  return next;
}

function load() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY);
    return raw ? migrate(typeof raw === 'string' ? JSON.parse(raw) : raw) : seed();
  } catch (error) { return seed(); }
}

function persist(state) {
  try { wx.setStorageSync(STORAGE_KEY, JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION })); return { ok: true }; }
  catch (error) { return { ok: false, error }; }
}

function clear() { try { wx.removeStorageSync(STORAGE_KEY); } catch (error) { /* best effort */ } }

module.exports = { STORAGE_KEY, SCHEMA_VERSION, seed, migrate, load, persist, clear };
