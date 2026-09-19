const ACCT = Object.freeze({ BANK1: 'BANK1', POOL2: 'POOL2', POCKET3: 'POCKET3', BILL: 'BILL', OUT: 'OUT' });

function sum(items, predicate = () => true) {
  return items.filter(predicate).reduce((total, item) => total + item.amount, 0);
}

function accountBalances(transfers, expenses, opening = {}, specials = [], adjusts = []) {
  const balances = { [ACCT.BANK1]: opening[ACCT.BANK1] || 0, [ACCT.POOL2]: opening[ACCT.POOL2] || 0, [ACCT.POCKET3]: opening[ACCT.POCKET3] || 0, [ACCT.BILL]: opening[ACCT.BILL] || 0, [ACCT.OUT]: opening[ACCT.OUT] || 0 };
  transfers.forEach(({ from, to, amount }) => { balances[from] -= amount; balances[to] += amount; });
  expenses.forEach(({ account = ACCT.BANK1, amount }) => { balances[account] -= amount; balances[ACCT.OUT] += amount; });
  specials.forEach(({ from = ACCT.POCKET3, amount }) => { balances[from] -= amount; balances[ACCT.OUT] += amount; });
  adjusts.forEach(({ acct, diff }) => {
    if (Object.prototype.hasOwnProperty.call(balances, acct) && Number.isInteger(diff)) balances[acct] += diff;
  });
  return balances;
}

function dailySpent(expenses, date) { return sum(expenses, item => item.date === date); }
function remainingDailyBudget(expenses, date, dailyBudget) { return dailyBudget - dailySpent(expenses, date); }

function dailySeries(expenses, start, days, { limit, budget } = {}) {
  const spentByDate = new Map();
  expenses.forEach(item => spentByDate.set(item.date, (spentByDate.get(item.date) || 0) + item.amount));
  const [year, month, day] = start.split('-').map(Number);
  const cursor = new Date(Date.UTC(year, month - 1, day));
  const dailyBudget = Number.isInteger(budget) ? budget : 0;
  const scaleLimit = Number.isInteger(limit) && limit > 0 ? limit : Math.max(dailyBudget * 1.5, 7000);
  return Array.from({ length: days }, () => {
    const date = cursor.toISOString().slice(0, 10);
    const spent = spentByDate.get(date) || 0;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    return { date, label: date.slice(5).replace('-', '/'), spent, height: Math.max(3, Math.min(100, (spent / scaleLimit) * 100)), used: spent > 0, over: spent > dailyBudget };
  });
}

function createExpense({ id, date, category, amount, note = '' }) {
  if (!id || !date || !category || !Number.isInteger(amount) || amount <= 0) {
    throw new TypeError('expense requires id, date, category and positive integer amount');
  }
  return { id, date, category, amount, note, account: ACCT.BANK1, createdAt: new Date().toISOString() };
}

// 冲正记录：追加式负向支出，只用于更正误记的原始支出。原记录保持不动，
// 余额派生（accountBalances）里两笔自动抵消，因此不需要重写历史批次。
function createExpenseReversal({ id, date, category, amount, reversalOf, note = '', account = ACCT.BANK1 }) {
  if (!id || !date || !category || !reversalOf) throw new TypeError('reversal requires id, date, category and reversalOf');
  if (!Number.isInteger(amount) || amount <= 0) throw new TypeError('reversal requires the positive amount of the original expense');
  return { id, date, category, amount: -amount, note, account, reversalOf, createdAt: new Date().toISOString() };
}

// 专项冲正：小荷包的计划内支出记错了，同样只追加负向记录；
// 专项不参与批次额度核算，所以不需要补退。
function createSpecialReversal({ id, date, reason, amount, reversalOf, note = '', from = ACCT.POCKET3 }) {
  if (!id || !date || !reason || !reversalOf) throw new TypeError('special reversal requires id, date, reason and reversalOf');
  if (!Number.isInteger(amount) || amount <= 0) throw new TypeError('special reversal requires the positive amount of the original special');
  return { id, date, reason, amount: -amount, note, from, to: ACCT.OUT, reversalOf, createdAt: new Date().toISOString() };
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

module.exports = { ACCT, sum, accountBalances, dailySpent, remainingDailyBudget, dailySeries, createExpense, createExpenseReversal, createSpecial, createSpecialReversal, createTransfer };
