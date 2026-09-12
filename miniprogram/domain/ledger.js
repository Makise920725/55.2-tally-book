const ACCT = Object.freeze({ BANK1: 'BANK1', POOL2: 'POOL2', POCKET3: 'POCKET3', BILL: 'BILL', OUT: 'OUT' });

function sum(items, predicate = () => true) {
  return items.filter(predicate).reduce((total, item) => total + item.amount, 0);
}

function accountBalances(transfers, expenses, opening = {}) {
  const balances = { [ACCT.BANK1]: opening[ACCT.BANK1] || 0, [ACCT.POOL2]: opening[ACCT.POOL2] || 0, [ACCT.POCKET3]: opening[ACCT.POCKET3] || 0, [ACCT.BILL]: opening[ACCT.BILL] || 0, [ACCT.OUT]: opening[ACCT.OUT] || 0 };
  transfers.forEach(({ from, to, amount }) => { balances[from] -= amount; balances[to] += amount; });
  expenses.forEach(({ account = ACCT.BANK1, amount }) => { balances[account] -= amount; balances[ACCT.OUT] += amount; });
  return balances;
}

function dailySpent(expenses, date) { return sum(expenses, item => item.date === date); }
function remainingDailyBudget(expenses, date, dailyBudget) { return dailyBudget - dailySpent(expenses, date); }

module.exports = { ACCT, sum, accountBalances, dailySpent, remainingDailyBudget };
