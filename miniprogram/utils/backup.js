// 换机/恢复用的是「完整快照」，不是 CSV：
// CSV 是给人看的单向导出（分类名、账户中文名、方向），丢了 daySlots、期初余额、已执行发薪日等结算依据，
// 用它恢复会静默改变退款与补差口径。所以备份走 JSON 全量，恢复前强制校验。
const { SCHEMA_VERSION } = require('./storage');

const BACKUP_FORMAT = 'tally-book-backup';
const BACKUP_FORMAT_VERSION = 1;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT_LENGTH = 4 * 1024 * 1024;

function backupFileName(stamp) { return `55kuai2-backup-${stamp}.json`; }

function createBackupText(state, now = new Date()) {
  return JSON.stringify({
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    app: '55块2',
    exportedAt: now.toISOString(),
    counts: countEntries(state),
    state
  });
}

function countEntries(state) {
  const ledger = (state && state.ledger) || {};
  return {
    expenses: (ledger.expenses || []).length,
    transfers: (ledger.transfers || []).length,
    specials: (ledger.specials || []).length,
    adjusts: (ledger.adjusts || []).length
  };
}

function describeState(state) {
  const counts = countEntries(state);
  return `支出 ${counts.expenses} 笔 · 划转 ${counts.transfers} 笔 · 专项 ${counts.specials} 笔 · 校准 ${counts.adjusts} 条`;
}

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

// 只校验“会不会把账本写坏”的部分：id 唯一、金额是整数分、日期是 YYYY-MM-DD、冲正指向存在。
function validateState(state, problems) {
  if (!isPlainObject(state)) { problems.push('备份里没有 state 对象'); return; }
  if (!isPlainObject(state.ledger)) { problems.push('state.ledger 缺失'); return; }
  const ids = new Set();
  const collectIds = list => (list || []).forEach(item => {
    if (!item || typeof item.id !== 'string' || !item.id) { problems.push('存在缺少 id 的流水'); return; }
    if (ids.has(item.id)) problems.push(`流水 id 重复：${item.id}`);
    ids.add(item.id);
  });
  ['expenses', 'transfers', 'specials', 'adjusts'].forEach(key => {
    const list = state.ledger[key];
    if (list && !Array.isArray(list)) problems.push(`ledger.${key} 不是数组`);
    collectIds(list);
  });
  ['expenses', 'specials'].forEach(key => {
    (state.ledger[key] || []).forEach(item => {
      if (!DATE_RE.test(item.date || '')) problems.push(`${key} ${item.id} 的业务日期不合法`);
      if (!Number.isInteger(item.amount)) problems.push(`${key} ${item.id} 金额必须是整数分`);
      if (item.reversalOf) {
        if (!(item.amount < 0)) problems.push(`${key} ${item.id} 是冲正记录，金额必须为负`);
        else if (!ids.has(item.reversalOf)) problems.push(`${key} ${item.id} 指向的原始流水 ${item.reversalOf} 不存在`);
      } else if (item.amount <= 0) problems.push(`${key} ${item.id} 金额必须是正整数分`);
    });
  });
  (state.ledger.transfers || []).forEach(item => {
    if (!DATE_RE.test(item.date || '')) problems.push(`transfers ${item.id} 的业务日期不合法`);
    if (!item.from || !item.to || !item.kind) problems.push(`transfers ${item.id} 缺少账户或类型`);
    if (!Number.isInteger(item.amount) || item.amount <= 0) problems.push(`transfers ${item.id} 金额必须是正整数分`);
  });
  (state.ledger.adjusts || []).forEach(item => {
    if (!DATE_RE.test(item.date || '')) problems.push(`adjusts ${item.id} 的业务日期不合法`);
    if (!item.acct) problems.push(`adjusts ${item.id} 缺少账户`);
    if (!Number.isInteger(item.diff)) problems.push(`adjusts ${item.id} 差额必须是整数分`);
  });
  if (state.categories && !Array.isArray(state.categories)) problems.push('categories 不是数组');
  if (state.daySlots && !isPlainObject(state.daySlots)) problems.push('daySlots 不是对象');
  if (state.openingBalances) {
    if (!isPlainObject(state.openingBalances)) problems.push('openingBalances 不是对象');
    else Object.keys(state.openingBalances).forEach(key => {
      if (!Number.isInteger(state.openingBalances[key])) problems.push(`期初余额 ${key} 必须是整数分`);
    });
  }
  const config = state.config;
  if (!isPlainObject(config)) problems.push('config 缺失');
  else {
    if (!DATE_RE.test(config.startDate || '') || !DATE_RE.test(config.deadline || '')) problems.push('config 的计划日期不合法');
    if (!Number.isInteger(config.dailyBudget) || config.dailyBudget <= 0) problems.push('config.dailyBudget 必须是正整数分');
  }
}

// 返回 { ok, state, meta, problems }：任何一条问题都不允许恢复。
function parseBackupText(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, problems: ['内容为空'] };
  if (text.length > MAX_TEXT_LENGTH) return { ok: false, problems: ['备份文件过大'] };
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { return { ok: false, problems: ['不是合法的 JSON 文件'] }; }
  if (!isPlainObject(parsed) || parsed.format !== BACKUP_FORMAT) return { ok: false, problems: ['这不是 55块2 的备份文件'] };
  if (parsed.formatVersion !== BACKUP_FORMAT_VERSION) return { ok: false, problems: [`不支持的备份格式版本 v${parsed.formatVersion}`] };
  if (Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion > SCHEMA_VERSION) {
    return { ok: false, problems: [`备份来自更新的版本（v${parsed.schemaVersion} > v${SCHEMA_VERSION}），请先升级小程序`] };
  }
  const problems = [];
  validateState(parsed.state, problems);
  if (problems.length) return { ok: false, problems: problems.slice(0, 8), totalProblems: problems.length };
  return { ok: true, state: parsed.state, meta: { exportedAt: parsed.exportedAt, app: parsed.app, counts: parsed.counts } };
}

module.exports = { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, backupFileName, createBackupText, parseBackupText, describeState, countEntries };
