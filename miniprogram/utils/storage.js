const STORAGE_KEY = 'p5519';
const ROLLBACK_KEY = 'p5519.rollback';   // 恢复前自动留下的旧账本，用于一键撤销
const META_KEY = 'p5519.meta';           // 最近备份/恢复时间等杂项
const SCHEMA_VERSION = 4;

function seed() { return require('../domain/plan').createInitialState(); }

function migrate(state) {
  const { CONFIG } = require('../domain/plan');
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
  // 期次是纯派生数据，每次装载都重算：缓存里带着一份旧情景的期次（例如换过预算情景、
  // 或恢复了一份 periods 为空/陈旧的备份）会让页面失去期次依据、算错目标。
  // 已执行期次的金额以流水为准，所以重算不会改写历史。
  next.periods = require('../domain/plan').periodsForState(next);
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

function readKey(key) {
  try {
    const raw = wx.getStorageSync(key);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) { return null; }
}

function writeKey(key, value) {
  try { wx.setStorageSync(key, JSON.stringify(value)); return { ok: true }; }
  catch (error) { return { ok: false, error }; }
}

// 备份/恢复的元信息与可撤销快照单独存放，不混进账本本体，免得污染派生逻辑。
function readMeta() { return readKey(META_KEY) || {}; }
function writeMeta(patch) { return writeKey(META_KEY, { ...readMeta(), ...patch }); }
function saveRollback(state) { return writeKey(ROLLBACK_KEY, { savedAt: new Date().toISOString(), state }); }
function readRollback() {
  const slot = readKey(ROLLBACK_KEY);
  if (!slot || !slot.state) return null;
  return { savedAt: slot.savedAt, state: migrate(slot.state) };
}
function clearRollback() { try { wx.removeStorageSync(ROLLBACK_KEY); return { ok: true }; } catch (error) { return { ok: false, error }; } }

function clear() { try { wx.removeStorageSync(STORAGE_KEY); } catch (error) { /* best effort */ } }

module.exports = { STORAGE_KEY, ROLLBACK_KEY, META_KEY, SCHEMA_VERSION, seed, migrate, load, persist, clear, readMeta, writeMeta, saveRollback, readRollback, clearRollback };
