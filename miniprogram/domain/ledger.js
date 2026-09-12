const ACCT = Object.freeze({ BANK1: 'BANK1', POOL2: 'POOL2', POCKET3: 'POCKET3', BILL: 'BILL', OUT: 'OUT' });

function sum(items, predicate = () => true) {
  return items.filter(predicate).reduce((total, item) => total + item.amount, 0);
}

function accountBalances(transfers, expenses, opening = {}, specials = []) {
  const balances = { [ACCT.BANK1]: opening[ACCT.BANK1] || 0, [ACCT.POOL2]: opening[ACCT.POOL2] || 0, [ACCT.POCKET3]: opening[ACCT.POCKET3] || 0, [ACCT.BILL]: opening[ACCT.BILL] || 0, [ACCT.OUT]: opening[ACCT.OUT] || 0 };
  transfers.forEach(({ from, to, amount }) => { balances[from] -= amount; balances[to] += amount; });
  expenses.forEach(({ account = ACCT.BANK1, amount }) => { balances[account] -= amount; balances[ACCT.OUT] += amount; });
  specials.forEach(({ from = ACCT.POCKET3, amount }) => { balances[from] -= amount; balances[ACCT.OUT] += amount; });
  return balances;
}

function dailySpent(expenses, date) { return sum(expenses, item => item.date === date); }
function remainingDailyBudget(expenses, date, dailyBudget) { return dailyBudget - dailySpent(expenses, date); }

function dailySeries(expenses, start, days, limit = 7000) {
  const [year, month, day] = start.split('-').map(Number);
  const cursor = new Date(Date.UTC(year, month - 1, day));
  return Array.from({ length: days }, (_, index) => {
    const date = cursor.toISOString().slice(0, 10);
    const spent = dailySpent(expenses, date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    return { date, label: date.slice(5).replace('-', '/'), spent, height: Math.max(3, Math.min(100, (spent / limit) * 100)), used: spent > 0, over: spent > 5519 };
  });
}

function createExpense({ id, date, category, amount, note = '' }) {
  if (!id || !date || !category || !Number.isInteger(amount) || amount <= 0) {
    throw new TypeError('expense requires id, date, category and positive integer amount');
  }
  return { id, date, category, amount, note, account: ACCT.BANK1, createdAt: new Date().toISOString() };
}

function createTransfer({ id, date, from, to, amount, kind }) {
  if (!id || !date || !from || !to || !Number.isInteger(amount) || amount <= 0 || !kind) {
    throw new TypeError('transfer requires id, date, accounts, kind and positive integer amount');
  }
  return { id, date, from, to, amount, kind, createdAt: new Date().toISOString() };
}

function createSpecial({ id, date, reason, amount, note = '' }) {
  if (!id || !date || !reason || !Number.isInteger(amount) || amount <= 0) throw new TypeError('special requires id, date, reason and positive integer amount');
  return { id, date, reason, amount, note, from: ACCT.POCKET3, to: ACCT.OUT, createdAt: new Date().toISOString() };
}

module.exports = { ACCT, sum, accountBalances, dailySpent, remainingDailyBudget, dailySeries, createExpense, createTransfer, createSpecial };
