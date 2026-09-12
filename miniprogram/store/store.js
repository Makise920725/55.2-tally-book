const { createExpense, createTransfer, createSpecial, ACCT, remainingDailyBudget } = require('../domain/ledger');
const { yuanToFen } = require('../domain/money');
const storage = require('../utils/storage');

let state = null;
const listeners = new Set();

function getState() { if (!state) state = storage.load(); return state; }
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function notify() { listeners.forEach(listener => listener(state)); }

function commit(next) {
  state = next;
  const result = storage.persist(state);
  notify();
  return { state, persisted: result.ok };
}

function addExpense({ date, category, amountYuan, note = '' }) {
  const current = getState();
  if (current.daySlots && current.daySlots[date] && current.daySlots[date].closed) {
    return { state: current, persisted: true, blocked: 'closed' };
  }
  const expense = createExpense({ id: `expense_${Date.now()}`, date, category, amount: yuanToFen(amountYuan), note });
  const beforeSpent = current.ledger.expenses.filter(item => item.date === date).reduce((total, item) => total + item.amount, 0);
  const afterSpent = beforeSpent + expense.amount;
  const budget = current.config.dailyBudget;
  const beforeOver = Math.max(0, beforeSpent - budget);
  const afterOver = Math.max(0, afterSpent - budget);
  const transfers = [...current.ledger.transfers];
  if (afterOver > beforeOver) {
    transfers.push(createTransfer({ id: `cover_${Date.now()}`, date, from: ACCT.POOL2, to: ACCT.BANK1, amount: afterOver - beforeOver, kind: 'overspend_cover' }));
  }
  return commit({ ...current, ledger: { ...current.ledger, expenses: [...current.ledger.expenses, expense], transfers } });
}

function settleDay({ date, dailyBudget }) {
  const current = getState();
  if (current.daySlots && current.daySlots[date] && current.daySlots[date].closed) return { state: current, persisted: true, transfer: null, alreadyClosed: true };
  const amount = Math.max(0, remainingDailyBudget(current.ledger.expenses, date, dailyBudget));
  if (!amount) {
    const daySlots = { ...current.daySlots, [date]: { ...(current.daySlots[date] || {}), closed: true, refunded: 0 } };
    return { ...commit({ ...current, daySlots }), transfer: null };
  }
  const transfer = createTransfer({ id: `refund_${Date.now()}`, date, from: ACCT.BANK1, to: ACCT.POOL2, amount, kind: 'daily_refund' });
  const daySlots = { ...current.daySlots, [date]: { closed: true, refunded: amount } };
  return { ...commit({ ...current, daySlots, ledger: { ...current.ledger, transfers: [...current.ledger.transfers, transfer] } }), transfer };
}

function reopenDay(date) {
  const current = getState();
  if (!current.daySlots || !current.daySlots[date] || !current.daySlots[date].closed) return { state: current, persisted: true };
  const daySlots = { ...current.daySlots, [date]: { ...current.daySlots[date], closed: false, reopened: true } };
  return commit({ ...current, daySlots });
}

function reset() { state = storage.seed(); storage.persist(state); notify(); return state; }

function togglePaydayStep(periodIndex, step) {
  const current = getState();
  const key = `${periodIndex}-${step}`;
  const paydaySteps = { ...(current.paydaySteps || {}), [key]: !(current.paydaySteps || {})[key] };
  return commit({ ...current, paydaySteps });
}

function setMode(mode) {
  if (mode !== 'daily' && mode !== 'three-day') throw new TypeError('mode must be daily or three-day');
  const current = getState();
  return commit({ ...current, mode });
}

function addAdjust({ date, acct, realBalanceYuan, bookBalanceYuan, note = '' }) {
  const realBalance = yuanToFen(realBalanceYuan);
  const bookBalance = yuanToFen(bookBalanceYuan);
  const adjust = { id: `adjust_${Date.now()}`, date, acct, realBalance, bookBalance, diff: realBalance - bookBalance, note, createdAt: new Date().toISOString() };
  const current = getState();
  return commit({ ...current, ledger: { ...current.ledger, adjusts: [...current.ledger.adjusts, adjust] } });
}

function executePayday(periodIndex = 1) {
  const current = getState();
  if (current.executedPaydays[periodIndex]) return { state: current, persisted: true, alreadyExecuted: true };
  const period = current.periods[periodIndex - 1];
  if (!period) throw new RangeError('unknown payday period');
  const date = period.payDate;
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
  const special = createSpecial({ id: `special_${Date.now()}`, date, reason, amount: yuanToFen(amountYuan), note });
  const current = getState();
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
  const { CONFIG, daysFrom, allocationForMode } = require('../domain/plan');
  if (date < CONFIG.startDate) return { state: current, persisted: true, blocked: 'not_started' };
  const dayNumber = daysFrom(CONFIG.startDate, date);
  const amount = allocationForMode(current.config.dailyBudget, current.mode) * (current.mode === 'three-day' ? (dayNumber % 3 === 0 ? 1 : 0) : 1);
  if (!amount) return { state: current, persisted: true, skipped: true };
  const existing = current.ledger.transfers.some(item => item.date === date && item.kind === 'daily_alloc');
  if (existing) return { state: current, persisted: true, alreadyAllocated: true };
  const transfer = createTransfer({ id: `alloc_${Date.now()}`, date, from: ACCT.POOL2, to: ACCT.BANK1, amount, kind: 'daily_alloc' });
  return { ...commit({ ...current, ledger: { ...current.ledger, transfers: [...current.ledger.transfers, transfer] } }), transfer };
}

module.exports = { getState, subscribe, addExpense, settleDay, reopenDay, togglePaydayStep, executePayday, addSpecial, setMode, setScenario, allocateDay, addAdjust, reset };
