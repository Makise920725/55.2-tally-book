// 换机/恢复用的是「完整快照」，不是 CSV：
// CSV 是给人看的单向导出（分类名、账户中文名、方向），丢了 daySlots、期初余额、已执行发薪日等结算依据，
// 用它恢复会静默改变退款与补差口径。所以备份走 JSON 全量，恢复前强制校验。
const { SCHEMA_VERSION } = require('./storage');
const { ACCT } = require('../domain/ledger');
const { SCENARIOS, derivePeriods, periodIncomeTotals } = require('../domain/plan');

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

// ---- 账务不变量校验：结构合法不等于账本可用 ----
// 结构校验只管「能不能读」；下面这层管「读进来会不会把派生逻辑带偏」：
// 账户集合、划转方向、kind 白名单、批次身份互不重叠、已执行发薪日与流水一致……
// 这些一旦坏了，余额、退款、余粮都会算错，所以恢复前一律拒绝，让人去修备份而不是将错就错。
const ACCOUNTS = Object.freeze([ACCT.BANK1, ACCT.POOL2, ACCT.POCKET3, ACCT.BILL, ACCT.OUT]);
const TRANSFER_KINDS = Object.freeze(['payday_income', 'allowance_income', 'bill_repay', 'payday_budget', 'payday_save', 'daily_alloc', 'overspend_cover', 'daily_refund', 'carry_over']);
// 生活费两段到账的固定口径：金额恒为 2,000，日期必须落在本期区间内，每期最多一笔。
const ALLOWANCE_AMOUNT = 200000;
const INCOME_KINDS = Object.freeze(['payday_income', 'allowance_income', 'bill_repay', 'payday_budget', 'payday_save']);
const MODES = Object.freeze(['daily', 'three-day']);
const PERIOD_COUNT = 5;
const PAYDAY_STEP_COUNT = 6;
const MAX_NOTE_LENGTH = 500;
const NON_NEGATIVE_INT = ['allocated', 'plannedBudget', 'refunded'];

function batchOf(slots, key) {
  const slot = slots[key] || {};
  return slot.batchStart && slot.batchEnd ? { start: slot.batchStart, end: slot.batchEnd } : null;
}

function validateInvariants(state, problems) {
  const ledger = state.ledger || {};
  (ledger.transfers || []).forEach(item => {
    if (item.from && !ACCOUNTS.includes(item.from)) problems.push(`transfers ${item.id} 的来源账户 ${item.from} 不在账本账户集合里`);
    if (item.to && !ACCOUNTS.includes(item.to)) problems.push(`transfers ${item.id} 的去向账户 ${item.to} 不在账本账户集合里`);
    if (item.from && item.from === item.to) problems.push(`transfers ${item.id} 的转入转出是同一个账户`);
    if (item.kind && !TRANSFER_KINDS.includes(item.kind)) problems.push(`transfers ${item.id} 的划转类型 ${item.kind} 无法识别`);
    if (item.batchKey !== undefined && typeof item.batchKey !== 'string') problems.push(`transfers ${item.id} 的批次标识必须是字符串`);
    // arrivalId 回指「这一笔到账」的收入流水，撤销整组时靠它精确摘除；指向不存在就说明账本被改坏了。
    if (item.arrivalId !== undefined) {
      const arrival = (ledger.transfers || []).find(other => other.id === item.arrivalId);
      if (!arrival || !item.arrivalId.startsWith(`pay_in_`) && !item.arrivalId.startsWith(`allow_`)) problems.push(`transfers ${item.id} 的 arrivalId ${item.arrivalId} 找不到对应的到账流水`);
      else if (item.arrivalId === item.id) problems.push(`transfers ${item.id} 的 arrivalId 指向了自己`);
    }
    // periodIndex 只允许出现在期次流水上且必须是 1..5；两段到账靠它把流水归到正确期次。
    if (item.periodIndex !== undefined) {
      if (!INCOME_KINDS.includes(item.kind)) problems.push(`transfers ${item.id} 是非期次流水，不该带 periodIndex`);
      else if (!Number.isInteger(item.periodIndex) || item.periodIndex < 1 || item.periodIndex > PERIOD_COUNT) problems.push(`transfers ${item.id} 的期次 ${item.periodIndex} 不存在`);
    }
  });
  (ledger.expenses || []).forEach(item => {
    if (item.account && !ACCOUNTS.includes(item.account)) problems.push(`expenses ${item.id} 的账户 ${item.account} 不在账本账户集合里`);
  });
  (ledger.specials || []).forEach(item => {
    if (item.from && !ACCOUNTS.includes(item.from)) problems.push(`specials ${item.id} 的来源账户 ${item.from} 不在账本账户集合里`);
    if (item.to && !ACCOUNTS.includes(item.to)) problems.push(`specials ${item.id} 的去向账户 ${item.to} 不在账本账户集合里`);
  });
  (ledger.adjusts || []).forEach(item => {
    if (item.acct && !ACCOUNTS.includes(item.acct)) problems.push(`adjusts ${item.id} 的账户 ${item.acct} 不在账本账户集合里`);
    if (Number.isInteger(item.realBalance) && Number.isInteger(item.bookBalance) && item.diff !== item.realBalance - item.bookBalance) {
      problems.push(`adjusts ${item.id} 的差额与两项余额对不上`);
    }
  });
  ['expenses', 'transfers', 'specials', 'adjusts'].forEach(key => (ledger[key] || []).forEach(item => {
    ['note', 'reason'].forEach(field => {
      if (typeof item[field] === 'string' && item[field].length > MAX_NOTE_LENGTH) problems.push(`${key} ${item.id} 的${field === 'note' ? '备注' : '名称'}过长`);
    });
  }));

  // 缺字段留给 storage.migrate 补齐默认值；只有「明明写了却认不出」才算坏数据。
  if (state.mode !== undefined && !MODES.includes(state.mode)) problems.push(`结算模式 ${state.mode} 无法识别`);
  const scenario = (state.config || {}).scenario;
  if (scenario !== undefined && !Object.prototype.hasOwnProperty.call(SCENARIOS, scenario)) problems.push(`预算情景 ${scenario} 无法识别`);
  const config = state.config || {};
  if (DATE_RE.test(config.startDate || '') && DATE_RE.test(config.deadline || '') && config.startDate > config.deadline) {
    problems.push(`计划起始日 ${config.startDate} 晚于截止日 ${config.deadline}`);
  }

  const slots = state.daySlots || {};
  Object.keys(slots).forEach(key => {
    if (!DATE_RE.test(key)) { problems.push(`daySlots 的键 ${key} 不是合法日期`); return; }
    const slot = slots[key];
    if (!isPlainObject(slot)) { problems.push(`daySlots ${key} 不是对象`); return; }
    ['closed', 'reopened'].forEach(field => { if (slot[field] !== undefined && typeof slot[field] !== 'boolean') problems.push(`daySlots ${key}.${field} 必须是布尔值`); });
    NON_NEGATIVE_INT.forEach(field => { if (slot[field] !== undefined && (!Number.isInteger(slot[field]) || slot[field] < 0)) problems.push(`daySlots ${key}.${field} 必须是非负整数分`); });
    const batch = batchOf(slots, key);
    if (!batch) {
      if (slot.batchStart || slot.batchEnd) problems.push(`daySlots ${key} 的批次起止不完整`);
      return;
    }
    if (!DATE_RE.test(batch.start) || !DATE_RE.test(batch.end) || batch.start > batch.end) problems.push(`daySlots ${key} 的批次范围不合法`);
    else if (key < batch.start || key > batch.end) problems.push(`daySlots ${key} 落在自己批次范围 ${batch.start}→${batch.end} 之外`);
    if (slot.batchMode !== undefined && !MODES.includes(slot.batchMode)) problems.push(`daySlots ${key}.batchMode 无法识别`);
  });
  // 一天只属于一个批次：两个批次区间重叠就意味着补差/退款会被两套口径各算一次。
  const identities = [...new Set(Object.keys(slots).map(key => {
    const batch = batchOf(slots, key);
    return batch ? `${batch.start}~${batch.end}` : '';
  }).filter(Boolean))].map(text => { const [start, end] = text.split('~'); return { start, end }; });
  identities.forEach((left, index) => identities.slice(index + 1).forEach(right => {
    if (left.start <= right.end && right.start <= left.end && (left.start !== right.start || left.end !== right.end)) {
      problems.push(`批次 ${left.start}→${left.end} 与 ${right.start}→${right.end} 互相重叠`);
    }
  }));

  const allPeriods = derivePeriods();
  const salaryPeriods = new Set();
  const allowanceCount = {};
  (ledger.transfers || []).forEach(item => {
    if (item.kind !== 'payday_income' && item.kind !== 'allowance_income') return;
    // 新流水带 periodIndex；旧账本按发薪日匹配。
    const period = Number.isInteger(item.periodIndex) ? allPeriods[item.periodIndex - 1] : allPeriods.find(entry => entry.payDate === item.date);
    if (!period) return;
    if (item.kind === 'payday_income') salaryPeriods.add(period.index);
    else {
      allowanceCount[period.index] = (allowanceCount[period.index] || 0) + 1;
      if (item.amount !== ALLOWANCE_AMOUNT) problems.push(`transfers ${item.id} 的生活费金额必须是 ¥2,000.00`);
      if (item.date < period.payDate || item.date > period.rangeEnd) problems.push(`transfers ${item.id} 的生活费到账日不在第 ${period.index} 期区间内`);
    }
  });
  Object.keys(allowanceCount).forEach(index => {
    if (allowanceCount[index] > 1) problems.push(`第 ${index} 期登记了 ${allowanceCount[index]} 笔生活费`);
  });
  // 每一期「已安置 == 已到账」：工资 + 生活费进来多少，就必须有多少落到
  // 账单 / 预算池 / 小荷包三者之一。自选安置之后这条尤其要钉住 ——
  // 页面会校验合计，但备份文件可能被手改过，少了这条就会凭空蒸发或多出一笔钱。
  const periodTotals = periodIncomeTotals(ledger.transfers || []);
  Object.keys(periodTotals).forEach(key => {
    const item = periodTotals[key];
    const income = item.salaryIn + item.allowanceIn;
    const placed = item.billPlaced + item.poolPlaced + item.savePlaced;
    if (income > 0 && placed !== income) {
      problems.push(`第 ${item.index} 期已安置 ${placed} 分与已到账 ${income} 分对不上`);
    }
  });
  const incomeByDate = new Set((ledger.transfers || []).filter(item => item.kind === 'payday_income').map(item => item.date));
  Object.keys(state.executedPaydays || {}).forEach(key => {
    if (!/^[1-9][0-9]*$/.test(key) || Number(key) > PERIOD_COUNT) { problems.push(`已执行发薪日的期次 ${key} 不存在`); return; }
    if (!state.executedPaydays[key]) return;
    const period = derivePeriods()[Number(key) - 1];
    if (!period) { problems.push(`已执行发薪日的期次 ${key} 不存在`); return; }
    if (!salaryPeriods.has(Number(key)) && !incomeByDate.has(period.payDate)) problems.push(`第 ${key} 期标记为已执行，但 ${period.payDate} 没有工资到账流水`);
  });
  // v1.4.0 起步骤完成状态由流水派生，paydaySteps 只是历史备注：键是「期次-步骤」，值必须是布尔。
  Object.keys(state.paydaySteps || {}).forEach(key => {
    const matched = /^([1-9][0-9]*)-([1-9][0-9]*)$/.exec(key);
    if (!matched || Number(matched[1]) > PERIOD_COUNT || Number(matched[2]) > PAYDAY_STEP_COUNT) problems.push(`发薪日步骤 ${key} 不属于五期 × 六步`);
    else if (typeof state.paydaySteps[key] !== 'boolean') problems.push(`发薪日步骤 ${key} 必须是布尔值`);
  });
  if (state.categories !== undefined && (!Array.isArray(state.categories)
    || state.categories.some(item => !isPlainObject(item) || !item.id || !item.name))) {
    problems.push('categories 里有缺少 id 或名称的分类');
  }
}

// 备份里的 state.periods 一律不作为事实来源：期次是纯派生数据，
// 恢复时由 storage.migrate() 按「当前情景 + 已执行流水」重算，所以这里既不校验也不信任它。
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
  // 结构没问题再查账务不变量：派生余额、批次退款、发薪期次全靠这些前提成立。
  if (!problems.length) validateInvariants(parsed.state, problems);
  if (problems.length) return { ok: false, problems: problems.slice(0, 8), totalProblems: problems.length };
  return { ok: true, state: parsed.state, meta: { exportedAt: parsed.exportedAt, app: parsed.app, counts: parsed.counts } };
}

module.exports = { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, backupFileName, createBackupText, parseBackupText, describeState, countEntries };
