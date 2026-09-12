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
  const expense = createExpense({ id: `expense_${Date.now()}`, date, category, amount: yuanToFen(amountYuan), note });
  const current = getState();
  return commit({ ...current, ledger: { ...current.ledger, expenses: [...current.ledger.expenses, expense] } });
}

function settleDay({ date, dailyBudget }) {
  const current = getState();
  const amount = Math.max(0, remainingDailyBudget(current.ledger.expenses, date, dailyBudget));
  if (!amount) return { state: current, persisted: true, transfer: null };
  const transfer = createTransfer({ id: `refund_${Date.now()}`, date, from: ACCT.BANK1, to: ACCT.POOL2, amount, kind: 'daily_refund' });
  const daySlots = { ...current.daySlots, [date]: { closed: true, refunded: amount } };
  return { ...commit({ ...current, daySlots, ledger: { ...current.ledger, transfers: [...current.ledger.transfers, transfer] } }), transfer };
}

function reset() { state = storage.seed(); storage.persist(state); notify(); return state; }

module.exports = { getState, subscribe, addExpense, settleDay, reset };
