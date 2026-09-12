const { createExpense, createTransfer, ACCT, remainingDailyBudget } = require('../domain/ledger');
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
  return commit({ ...current, ledger: { ...current.ledger, expenses: [...current.ledger.expenses, expense] } });
}

function settleDay({ date, dailyBudget }) {
  const current = getState();
  if (current.daySlots && current.daySlots[date] && current.daySlots[date].closed) return { state: current, persisted: true, transfer: null, alreadyClosed: true };
  const amount = Math.max(0, remainingDailyBudget(current.ledger.expenses, date, dailyBudget));
  if (!amount) return { state: current, persisted: true, transfer: null };
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

module.exports = { getState, subscribe, addExpense, settleDay, reopenDay, togglePaydayStep, setMode, addAdjust, reset };
