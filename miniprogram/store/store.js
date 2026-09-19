const { createExpense, createTransfer, createSpecial, ACCT } = require('../domain/ledger');
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
  const allocated = allocationOf(current, allocationDate, budget);
  const hasAllocation = current.ledger.transfers.some(item => item.date === allocationDate && item.kind === 'daily_alloc')
    || Number.isInteger((current.daySlots[allocationDate] || {}).allocated);
  if (!hasAllocation) return { state: current, persisted: true, transfer: null, blocked: 'not_allocated' };
  if (range.mode === 'three-day' && date < expenseEnd) {
    return { state: current, persisted: true, batchPending: true, allocationDate, settlementDate: expenseEnd };
  }
  const spent = sumExpensesBetween(current.ledger.expenses, expenseStart, expenseEnd);
  // 余额宝已经为该批次补过的超支额，不能再当成“余粮”退回，否则池子会被扣两次。
  const covered = sumTransfersBetween(current.ledger.transfers, expenseStart, expenseEnd, 'overspend_cover');
  // 撤销封账后重复结算时，要先扣掉本批次已登记的退款，否则会重复退回余额宝。
  const alreadyRefunded = sumTransfersBetween(current.ledger.transfers, expenseStart, expenseEnd, 'daily_refund');
  const amount = Math.max(0, allocated + covered - spent - alreadyRefunded);
  if (!amount) {
    const daySlots = markBatchSlots(current.daySlots, range, { allocated, closed: true, refunded: alreadyRefunded });
    return { ...commit({ ...current, daySlots }), transfer: null, alreadyRefunded };
  }
  const transfer = createTransfer({ id: uid('refund'), date, from: ACCT.BANK1, to: ACCT.POOL2, amount, kind: 'daily_refund' });
  const daySlots = markBatchSlots(current.daySlots, range, { allocated, closed: true, refunded: alreadyRefunded + amount });
  return { ...commit({ ...current, daySlots, ledger: { ...current.ledger, transfers: [...current.ledger.transfers, transfer] } }), transfer, alreadyRefunded };
}

function sumTransfersBetween(transfers, start, end, kind) {
  return transfers.reduce((total, item) => (item.kind === kind && item.date >= start && item.date <= end ? total + item.amount : total), 0);
}

// 撤销封账必须同时撤销该批次的退款划转，否则重新结算会把同一笔钱退两次。
function reopenDay(date) {
  const current = getState();
  if (!current.daySlots || !current.daySlots[date] || !current.daySlots[date].closed) return { state: current, persisted: true };
  const { start, end } = resolveBatchRange(current, date);
  const refunded = sumTransfersBetween(current.ledger.transfers, start, end, 'daily_refund');
  const transfers = current.ledger.transfers.filter(item => !(item.kind === 'daily_refund' && item.date >= start && item.date <= end));
  const daySlots = Object.keys(current.daySlots).reduce((acc, key) => {
    if (key >= start && key <= end) acc[key] = { ...current.daySlots[key], closed: false, reopened: true, refunded: 0 };
    else acc[key] = current.daySlots[key];
    return acc;
  }, {});
  return { ...commit({ ...current, daySlots, ledger: { ...current.ledger, transfers } }), reversedRefund: refunded };
}

function reset() { state = storage.seed(); storage.persist(state); notify(); return state; }

function togglePaydayStep(periodIndex, step) {
  const current = getState();
  const key = `${periodIndex}-${step}`;
  const paydaySteps = { ...(current.paydaySteps || {}), [key]: !(current.paydaySteps || {})[key] };
  return commit({ ...current, paydaySteps });
}

function batchHasActivity(current, start, end) {
  const inRange = item => item.date >= start && item.date <= end;
  return current.ledger.expenses.some(inRange)
    || current.ledger.transfers.some(item => inRange(item) && ['daily_alloc', 'overspend_cover', 'daily_refund'].includes(item.kind));
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

module.exports = { getState, newCategoryId, subscribe, addExpense, settleDay, reopenDay, togglePaydayStep, executePayday, addSpecial, setMode, setScenario, allocateDay, addCategory, removeCategory, addAdjust, reset };
