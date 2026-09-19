const { createExpense, createExpenseReversal, createTransfer, createSpecial, createSpecialReversal, ACCT } = require('../domain/ledger');
const { yuanToFen } = require('../domain/money');
const { parseDate, dateKey, todayKey } = require('../domain/calendar');
const { allocationForMode } = require('../domain/plan');
const storage = require('../utils/storage');

let state = null;
const listeners = new Set();
let idSeed = 0;

// Date.now() 在同一毫秒内的连续操作会撞 id，叠加计数器保证流水 id 唯一。
function uid(prefix) { idSeed += 1; return `${prefix}_${Date.now()}_${idSeed}`; }

function getState() { if (!state) state = storage.load(); return state; }
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function notify() { listeners.forEach(listener => listener(state)); }

function commit(next) {
  state = next;
  const result = storage.persist(state);
  notify();
  return { state, persisted: result.ok };
}

function planOperationBlock(current, date) {
  if (date < current.config.startDate) return 'not_started';
  if (date > current.config.deadline) return 'ended';
  return null;
}

function addExpense({ date, category, amountYuan, note = '' }) {
  const current = getState();
  const planBlock = planOperationBlock(current, date);
  if (planBlock) return { state: current, persisted: true, blocked: planBlock };
  const range = resolveBatchRange(current, date);
  if (batchIsClosed(current, range)) {
    return { state: current, persisted: true, blocked: 'closed' };
  }
  const expense = createExpense({ id: uid('expense'), date, category, amount: yuanToFen(amountYuan), note });
  const { start, end } = range;
  const beforeSpent = sumExpensesBetween(current.ledger.expenses, start, end);
  const afterSpent = beforeSpent + expense.amount;
  const budget = allocationOf(current, start, current.config.dailyBudget);
  const beforeOver = Math.max(0, beforeSpent - budget);
  const afterOver = Math.max(0, afterSpent - budget);
  const transfers = [...current.ledger.transfers];
  if (afterOver > beforeOver) {
    transfers.push(createTransfer({ id: uid('cover'), date, from: ACCT.POOL2, to: ACCT.BANK1, amount: afterOver - beforeOver, kind: 'overspend_cover' }));
  }
  return commit({ ...current, ledger: { ...current.ledger, expenses: [...current.ledger.expenses, expense], transfers } });
}

// 三天一结时，一个批次的额度在第 1 天一次性划入，但要到第 3 天才整批结算。
function batchRange(date, mode) {
  if (mode !== 'three-day') return { start: date, end: date };
  const { CONFIG, daysFrom } = require('../domain/plan');
  const groupStart = Math.floor(daysFrom(CONFIG.startDate, date) / 3) * 3;
  const start = parseDate(CONFIG.startDate);
  start.setUTCDate(start.getUTCDate() + groupStart);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 2);
  const deadline = parseDate(CONFIG.deadline);
  if (end > deadline) end.setTime(deadline.getTime());
  return { start: dateKey(start), end: dateKey(end) };
}

function sumExpensesBetween(expenses, start, end) {
  return expenses.reduce((total, item) => (item.date >= start && item.date <= end ? total + item.amount : total), 0);
}

// 批次实际划入额：优先取当天真实存在的 daily_alloc 流水，其次取日槽记录，最后才回落到计划值。
function allocationOf(current, rangeStart, fallbackBudget) {
  const allocationTransfer = current.ledger.transfers.find(item => item.date === rangeStart && item.kind === 'daily_alloc');
  if (allocationTransfer) return allocationTransfer.amount;
  const slot = (current.daySlots || {})[rangeStart];
  if (slot && Number.isInteger(slot.allocated)) return slot.allocated;
  return allocationForMode(fallbackBudget, current.mode);
}

function resolveBatchRange(current, date) {
  const slots = current.daySlots || {};
  const recorded = Object.values(slots).find(slot => slot && slot.batchStart && slot.batchEnd && date >= slot.batchStart && date <= slot.batchEnd);
  if (recorded) return { start: recorded.batchStart, end: recorded.batchEnd, mode: recorded.batchMode || current.mode };
  const range = batchRange(date, current.mode);
  return { ...range, mode: current.mode };
}

function batchIsClosed(current, range) {
  return Object.keys(current.daySlots || {}).some(date => date >= range.start && date <= range.end && current.daySlots[date].closed);
}

function markBatchSlots(daySlots, range, values) {
  const next = { ...daySlots };
  let cursor = parseDate(range.start);
  const end = parseDate(range.end);
  while (cursor <= end) {
    const key = dateKey(cursor);
    next[key] = { ...(next[key] || {}), ...values, batchStart: range.start, batchEnd: range.end, batchMode: range.mode };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return next;
}

function settleDay({ date, dailyBudget } = {}) {
  const current = getState();
  // 计划区间外没有额度可退，否则会把整日预算凭空退回余额宝。
  const planBlock = planOperationBlock(current, date);
  if (planBlock) return { state: current, persisted: true, transfer: null, blocked: planBlock };
  if (current.daySlots && current.daySlots[date] && current.daySlots[date].closed) return { state: current, persisted: true, transfer: null, alreadyClosed: true };
  // 兜底必须用当前情景的每日额度，硬编码 CONFIG.dailyBudget 会在“省 / 松”情景下退错钱。
  const budget = Number.isInteger(dailyBudget) ? dailyBudget : current.config.dailyBudget;
  const range = resolveBatchRange(current, date);
  const allocationDate = range.start;
  const expenseEnd = range.end;
  const expenseStart = allocationDate;
  const hasAllocation = current.ledger.transfers.some(item => item.date === allocationDate && item.kind === 'daily_alloc')
    || Number.isInteger((current.daySlots[allocationDate] || {}).allocated);
  if (!hasAllocation) return { state: current, persisted: true, transfer: null, blocked: 'not_allocated' };
  if (range.mode === 'three-day' && date < expenseEnd) {
    return { state: current, persisted: true, batchPending: true, allocationDate, settlementDate: expenseEnd };
  }
  // 余额宝已经为该批次补过的超支额，不能再当成“余粮”退回，否则池子会被扣两次；
  // 撤销封账后重复结算时，也要先扣掉本批次已登记的退款（含冲正补退），否则会重复退回余额宝。
  const { allocated, covered, refunded: alreadyRefunded, due: amount } = batchNumbers(current, { start: expenseStart, end: expenseEnd }, budget);
  if (!amount) {
    const daySlots = markBatchSlots(current.daySlots, range, { allocated, closed: true, refunded: alreadyRefunded });
    return { ...commit({ ...current, daySlots }), transfer: null, alreadyRefunded };
  }
  const transfer = createTransfer({ id: uid('refund'), date, from: ACCT.BANK1, to: ACCT.POOL2, amount, kind: 'daily_refund' });
  const daySlots = markBatchSlots(current.daySlots, range, { allocated, closed: true, refunded: alreadyRefunded + amount });
  return { ...commit({ ...current, daySlots, ledger: { ...current.ledger, transfers: [...current.ledger.transfers, transfer] } }), transfer, alreadyRefunded };
}

function batchKeyOf(range) { return `${range.start}~${range.end}`; }

// 划转默认按日期落进批次；但“冲正补退”这类划转发生在今天、归属的是历史批次，
// 所以带 batchKey 的记录只认 batchKey，避免被当成当天批次的退款重复核算。
function inBatch(item, range) {
  if (item.batchKey) return item.batchKey === batchKeyOf(range);
  return item.date >= range.start && item.date <= range.end;
}

function sumTransfersInBatch(transfers, range, kind) {
  return transfers.reduce((total, item) => (item.kind === kind && inBatch(item, range) ? total + item.amount : total), 0);
}

// 一个批次的结算口径：额度、实际支出（含冲正的负向金额）、已补差、已退款、应退余额。
function batchNumbers(current, range, budget) {
  const allocated = allocationOf(current, range.start, budget);
  const spent = sumExpensesBetween(current.ledger.expenses, range.start, range.end);
  const covered = sumTransfersInBatch(current.ledger.transfers, range, 'overspend_cover');
  const refunded = sumTransfersInBatch(current.ledger.transfers, range, 'daily_refund');
  return { allocated, spent, covered, refunded, due: Math.max(0, allocated + covered - spent - refunded) };
}

// 撤销封账必须同时撤销该批次的退款划转，否则重新结算会把同一笔钱退两次。
function reopenDay(date) {
  const current = getState();
  if (!current.daySlots || !current.daySlots[date] || !current.daySlots[date].closed) return { state: current, persisted: true };
  const { start, end } = resolveBatchRange(current, date);
  const range = { start, end };
  const refunded = sumTransfersInBatch(current.ledger.transfers, range, 'daily_refund');
  const transfers = current.ledger.transfers.filter(item => !(item.kind === 'daily_refund' && inBatch(item, range)));
  const daySlots = Object.keys(current.daySlots).reduce((acc, key) => {
    if (key >= start && key <= end) acc[key] = { ...current.daySlots[key], closed: false, reopened: true, refunded: 0 };
    else acc[key] = current.daySlots[key];
    return acc;
  }, {});
  return { ...commit({ ...current, daySlots, ledger: { ...current.ledger, transfers } }), reversedRefund: refunded };
}

function reset() {
  // 重置演示数据同样是破坏性操作：先把当前账本留进可撤销槽位，误点还能救回来。
  storage.saveRollback(getState());
  state = storage.seed();
  storage.persist(state);
  notify();
  return state;
}

function togglePaydayStep(periodIndex, step) {
  const current = getState();
  const key = `${periodIndex}-${step}`;
  const paydaySteps = { ...(current.paydaySteps || {}), [key]: !(current.paydaySteps || {})[key] };
  return commit({ ...current, paydaySteps });
}

function batchHasActivity(current, start, end) {
  const range = { start, end };
  const inRange = item => item.date >= start && item.date <= end;
  return current.ledger.expenses.some(inRange)
    || current.ledger.transfers.some(item => ['daily_alloc', 'overspend_cover', 'daily_refund'].includes(item.kind) && inBatch(item, range));
}

function setMode(mode, asOfDate = todayKey()) {
  if (mode !== 'daily' && mode !== 'three-day') throw new TypeError('mode must be daily or three-day');
  const current = getState();
  if (mode === current.mode) return { state: current, persisted: true, unchanged: true };
  if (!planOperationBlock(current, asOfDate)) {
    const currentBatch = batchRange(asOfDate, 'three-day');
    if (current.mode === 'three-day') {
      const closed = Object.keys(current.daySlots || {}).some(date => date >= currentBatch.start && date <= currentBatch.end && current.daySlots[date].closed);
      if (batchHasActivity(current, currentBatch.start, currentBatch.end) && !closed) {
        return { state: current, persisted: true, blocked: 'active_batch', settlementDate: currentBatch.end };
      }
    }
    if (mode === 'three-day') {
      const { daysFrom } = require('../domain/plan');
      if (daysFrom(current.config.startDate, asOfDate) % 3 !== 0) {
        return { state: current, persisted: true, blocked: 'batch_boundary' };
      }
      if (batchHasActivity(current, currentBatch.start, currentBatch.end)) {
        return { state: current, persisted: true, blocked: 'active_batch', settlementDate: currentBatch.end };
      }
    }
  }
  return commit({ ...current, mode });
}

function addAdjust({ date, acct, realBalanceYuan, bookBalanceYuan, note = '' }) {
  const realBalance = yuanToFen(realBalanceYuan);
  const bookBalance = yuanToFen(bookBalanceYuan);
  const adjust = { id: uid('adjust'), date, acct, realBalance, bookBalance, diff: realBalance - bookBalance, note, createdAt: new Date().toISOString() };
  const current = getState();
  return commit({ ...current, ledger: { ...current.ledger, adjusts: [...current.ledger.adjusts, adjust] } });
}

function executePayday(periodIndex = 1, asOfDate = todayKey()) {
  const current = getState();
  if (current.executedPaydays[periodIndex]) return { state: current, persisted: true, alreadyExecuted: true };
  const period = current.periods[periodIndex - 1];
  if (!period) throw new RangeError('unknown payday period');
  const date = period.payDate;
  // 发薪日之前不允许预登记，避免把未来工资提前算进余额。
  if (date > asOfDate) return { state: current, persisted: true, blocked: 'not_reached', payDate: date };
  const transfers = [
    createTransfer({ id: `pay_in_${periodIndex}`, date, from: ACCT.OUT, to: ACCT.BANK1, amount: period.totalIn, kind: 'payday_income' }),
    createTransfer({ id: `bill_${periodIndex}`, date, from: ACCT.BANK1, to: ACCT.BILL, amount: period.billTotal, kind: 'bill_repay' }),
    createTransfer({ id: `budget_${periodIndex}`, date, from: ACCT.BANK1, to: ACCT.POOL2, amount: period.budgetToPool, kind: 'payday_budget' }),
    createTransfer({ id: `save_${periodIndex}`, date, from: ACCT.BANK1, to: ACCT.POCKET3, amount: period.saveToPocket, kind: 'payday_save' })
  ];
  const paydaySteps = { ...current.paydaySteps };
  for (let step = 1; step <= 5; step += 1) paydaySteps[`${periodIndex}-${step}`] = true;
  return commit({ ...current, paydaySteps, executedPaydays: { ...current.executedPaydays, [periodIndex]: true }, ledger: { ...current.ledger, transfers: [...current.ledger.transfers, ...transfers] } });
}

function addSpecial({ date, reason, amountYuan, note = '' }) {
  const current = getState();
  const planBlock = planOperationBlock(current, date);
  if (planBlock) return { state: current, persisted: true, blocked: planBlock };
  const special = createSpecial({ id: uid('special'), date, reason, amount: yuanToFen(amountYuan), note });
  return commit({ ...current, ledger: { ...current.ledger, specials: [...(current.ledger.specials || []), special] } });
}

function setScenario(scenario) {
  const { SCENARIOS, derivePeriods } = require('../domain/plan');
  if (!Object.prototype.hasOwnProperty.call(SCENARIOS, scenario)) throw new TypeError('unknown scenario');
  const current = getState();
  const dailyBudget = SCENARIOS[scenario];
  return commit({ ...current, config: { ...current.config, dailyBudget, scenario }, periods: derivePeriods({ dailyBudget }) });
}

function allocateDay({ date }) {
  const current = getState();
  const { CONFIG, daysFrom } = require('../domain/plan');
  const planBlock = planOperationBlock(current, date);
  if (planBlock) return { state: current, persisted: true, blocked: planBlock };
  // 已封账说明本批次已经结算清楚，再点一次会把额度重复划进工资卡。
  const range = resolveBatchRange(current, date);
  if (batchIsClosed(current, range)) return { state: current, persisted: true, blocked: 'closed' };
  const dayNumber = daysFrom(CONFIG.startDate, date);
  const amount = allocationForMode(current.config.dailyBudget, current.mode) * (current.mode === 'three-day' ? (dayNumber % 3 === 0 ? 1 : 0) : 1);
  if (!amount) return { state: current, persisted: true, skipped: true };
  const existing = current.ledger.transfers.some(item => item.date === range.start && item.kind === 'daily_alloc');
  if (existing) return { state: current, persisted: true, alreadyAllocated: true };
  const transfer = createTransfer({ id: uid('alloc'), date, from: ACCT.POOL2, to: ACCT.BANK1, amount, kind: 'daily_alloc' });
  const daySlots = { ...current.daySlots, [date]: { ...(current.daySlots[date] || {}), allocated: amount, batchStart: range.start, batchEnd: range.end, batchMode: current.mode } };
  return { ...commit({ ...current, daySlots, ledger: { ...current.ledger, transfers: [...current.ledger.transfers, transfer] } }), transfer };
}

// ---- 冲正（追加式更正）：支出与专项共用一套 planner ----
// 原记录一个字都不改，只追加一条负向记录，落在**原始记录的日期**上，
// 因此它永远和原单属于同一个批次（即便之后切换了结算模式）。
// 批次未封账时不需要任何补退，结算会按修正后的净支出重算补差与退款；
// 批次已封账时，把该批次“应退 − 已退”的差额作为一笔 daily_refund 补退给余额宝。
function reversibleInfo(current, source, id) {
  const list = (current.ledger || {})[source] || [];
  const original = list.find(item => item.id === id);
  if (!original) return { blocked: 'not_found' };
  // 冲正记录本身不能再被冲正；负向金额一律视为冲正记录。
  if (original.reversalOf || original.amount < 0) return { blocked: 'is_reversal' };
  const reversedFen = list.reduce((total, item) => (item.reversalOf === original.id ? total + Math.abs(item.amount) : total), 0);
  const remainingFen = original.amount - reversedFen;
  if (remainingFen <= 0) return { blocked: 'already_reversed' };
  return { original, reversedFen, remainingFen };
}

// 纯函数：只算不改状态，preview 与写入共用同一份算法，杜绝两套口径。
function planReversal(current, entry, asOfDate) {
  const source = entry.source === 'specials' ? 'specials' : 'expenses';
  const info = reversibleInfo(current, source, entry.id);
  if (info.blocked) return { blocked: info.blocked, source };
  const { original, reversedFen, remainingFen } = info;
  const portion = Number.isInteger(entry.amountFen) ? entry.amountFen : remainingFen;
  if (!Number.isInteger(portion) || portion <= 0 || portion > remainingFen) {
    return { blocked: 'bad_amount', source, remainingFen, reversedFen };
  }
  const dayBlock = planOperationBlock(current, asOfDate);
  if (dayBlock) return { blocked: dayBlock, source, remainingFen, reversedFen };
  const note = `${original.note ? `原备注：${original.note}` : ''}`;

  if (source === 'specials') {
    const reversal = createSpecialReversal({
      id: uid('special_reversal'), date: original.date, reason: original.reason, amount: portion,
      reversalOf: original.id, from: original.from || ACCT.POCKET3,
      note: `冲正 ${original.id}${note ? `（${note.replace('原备注：', '原备注：')}）` : ''}`
    });
    return {
      state: { ...current, ledger: { ...current.ledger, specials: [...(current.ledger.specials || []), reversal] } },
      reversal, trueUp: null, range: null, batchClosed: false, portionFen: portion, remainingFen: remainingFen - portion
    };
  }

  const range = resolveBatchRange(current, original.date);
  const numbers = batchNumbers(current, range, current.config.dailyBudget);
  const batchClosed = batchIsClosed(current, range);
  // 冲正后该批次“应退”比“已退”多出的部分，就是今天必须真实转回余额宝的钱。
  const dueAfterReversal = Math.max(0, numbers.allocated + numbers.covered - (numbers.spent - portion) - numbers.refunded);
  const trueUpFen = batchClosed ? dueAfterReversal : 0;
  const reversal = createExpenseReversal({
    id: uid('reversal'), date: original.date, category: original.category, amount: portion,
    reversalOf: original.id, account: original.account || ACCT.BANK1,
    note: `冲正 ${original.id}${note ? `（${note}）` : ''}`
  });
  let next = { ...current, ledger: { ...current.ledger, expenses: [...current.ledger.expenses, reversal] } };
  let trueUp = null;
  if (trueUpFen > 0) {
    trueUp = createTransfer({ id: uid('trueup'), date: asOfDate, from: ACCT.BANK1, to: ACCT.POOL2, amount: trueUpFen, kind: 'daily_refund' });
    trueUp.batchKey = batchKeyOf(range);
    // kind 仍是 daily_refund，结算核算才会把它算进“已退”；trueUp 只用于展示时区分文案。
    trueUp.trueUp = true;
    trueUp.note = `冲正补退 · 批次 ${range.start} → ${range.end}`;
    // range 自带批次当初记录的 batchMode，不能拿当前模式覆盖：
    // 否则“三日批次 → 切每日 → 冲正旧批次 → 撤销封账”会让整个三日批次在首日提前退款。
    next = {
      ...next,
      daySlots: markBatchSlots(next.daySlots, range, { allocated: numbers.allocated, closed: true, refunded: numbers.refunded + trueUpFen }),
      ledger: { ...next.ledger, transfers: [...next.ledger.transfers, trueUp] }
    };
  }
  return { state: next, reversal, trueUp, range, batchClosed, portionFen: portion, reversedFen: reversedFen + portion, remainingFen: remainingFen - portion, numbers };
}

// entries: [{ source: 'expenses' | 'specials', id, amountFen? }]；原子写入，任一条不成立就整体不落地。
function reverseEntries({ entries = [], asOfDate = todayKey() } = {}) {
  const current = getState();
  return runReversals(current, entries, asOfDate, { commitResult: true });
}

function runReversals(current, entries, asOfDate, { commitResult }) {
  let working = current;
  const plans = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = typeof entries[index] === 'string' ? { source: 'expenses', id: entries[index] } : entries[index];
    const planned = planReversal(working, entry, asOfDate);
    if (planned.blocked) {
      return { state: current, persisted: true, blocked: planned.blocked, failedIndex: index, failedId: entry.id, remainingFen: planned.remainingFen };
    }
    working = planned.state;
    plans.push(planned);
  }
  const summary = {
    count: plans.length,
    amountFen: plans.reduce((total, item) => total + item.portionFen, 0),
    trueUpFen: plans.reduce((total, item) => total + (item.trueUp ? item.trueUp.amount : 0), 0),
    trueUpCount: plans.filter(item => item.trueUp).length,
    closedCount: plans.filter(item => item.batchClosed).length
  };
  if (!commitResult) return { blocked: null, plans, summary };
  return {
    ...commit(working),
    plans,
    reversals: plans.map(item => item.reversal),
    trueUps: plans.filter(item => item.trueUp).map(item => item.trueUp),
    summary
  };
}

// 冲正前先算清楚会连带发生什么，让页面在确认弹窗里把金额写明白。
function previewReversal(entries, asOfDate = todayKey()) {
  const list = typeof entries === 'string' ? [{ source: 'expenses', id: entries }]
    : (Array.isArray(entries) ? entries.map(entry => (typeof entry === 'string' ? { source: 'expenses', id: entry } : entry)) : [entries]);
  return runReversals(getState(), list, asOfDate, { commitResult: false });
}

function singleResult(result, source) {
  if (result.blocked) return result;
  const plan = result.plans[0];
  return {
    ...result, reversal: plan.reversal, trueUp: plan.trueUp, range: plan.range,
    batchClosed: plan.batchClosed, amountFen: plan.portionFen,
    reversedFen: plan.reversedFen, remainingFen: plan.remainingFen, source
  };
}

// 不传 amountYuan 就整笔冲正；传了就只冲这一部分（累计不得超过原始金额）。
function reverseExpense({ id, amountYuan, asOfDate = todayKey() } = {}) {
  return singleResult(reverseEntries({ entries: [{ source: 'expenses', id, amountFen: toFenOrNull(amountYuan) }], asOfDate }), 'expenses');
}

function reverseSpecial({ id, amountYuan, asOfDate = todayKey() } = {}) {
  return singleResult(reverseEntries({ entries: [{ source: 'specials', id, amountFen: toFenOrNull(amountYuan) }], asOfDate }), 'specials');
}

function toFenOrNull(value) {
  if (value === undefined || value === null || value === '') return undefined;
  try { return yuanToFen(value); } catch (error) { return NaN; }
}

// ---- 备份与恢复：换机不再靠手动重录 ----
function backupMeta() {
  const meta = storage.readMeta();
  return { lastBackupAt: meta.lastBackupAt || '', lastRestoreAt: meta.lastRestoreAt || '', canUndoRestore: Boolean(storage.readRollback()) };
}

function markBackedUp() {
  storage.writeMeta({ lastBackupAt: new Date().toISOString() });
  return backupMeta();
}

// 恢复是整体替换：先把当前账本存进可撤销槽位，再写入新账本；
// 任何一步写不进去都立刻退回原状，绝不留半套状态。
function restoreFromBackup(nextState) {
  const current = getState();
  if (!storage.saveRollback(current).ok) return { ok: false, error: 'rollback-failed' };
  const result = commit(storage.migrate(nextState));
  if (!result.persisted) {
    const previous = storage.readRollback();
    if (previous) commit(previous.state);
    return { ok: false, error: 'persist-failed', state: getState() };
  }
  storage.writeMeta({ lastRestoreAt: new Date().toISOString() });
  return { ok: true, state: result.state, meta: backupMeta() };
}

function undoRestore() {
  const slot = storage.readRollback();
  if (!slot) return { ok: false, error: 'no-rollback' };
  const result = commit(slot.state);
  if (!result.persisted) return { ok: false, error: 'persist-failed' };
  storage.clearRollback();
  storage.writeMeta({ lastRestoreAt: '' });
  return { ok: true, state: result.state, meta: backupMeta() };
}

function newCategoryId() { return uid('category'); }

function addCategory({ id, name, mark }) {
  const current = getState();
  if (!id || !name || current.categories.some(item => item.id === id)) return { state: current, persisted: true, blocked: 'duplicate' };
  return commit({ ...current, categories: [...current.categories, { id, name, mark: mark || name.slice(0, 1), custom: true }] });
}

function removeCategory(id) {
  const current = getState();
  if (current.ledger.expenses.some(item => item.category === id)) return { state: current, persisted: true, blocked: 'used' };
  return commit({ ...current, categories: current.categories.filter(item => item.id !== id) });
}

module.exports = { getState, newCategoryId, subscribe, addExpense, reverseExpense, reverseSpecial, reverseEntries, previewReversal, settleDay, reopenDay, togglePaydayStep, executePayday, addSpecial, setMode, setScenario, allocateDay, addCategory, removeCategory, addAdjust, reset, backupMeta, markBackedUp, restoreFromBackup, undoRestore };
