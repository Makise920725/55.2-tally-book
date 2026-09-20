const { yuanToFen } = require('./money');
const { countPayableWorkdays } = require('./calendar');

const CONFIG = Object.freeze({
  startDate: '2026-09-24',
  dailyBudget: 5519,
  salaryPerDay: 15000,
  monthlyAllowance: 200000,
  goalMinimum: 1000000,
  targetSavings: 1199174,
  deadline: '2027-02-05'
});

const BILL_TOTALS = Object.freeze([184432, 137661, 92829, 83652, 72259]);
const DEFAULT_CATEGORIES = Object.freeze([
  { id: 'meal', name: '吃饭', mark: '食', custom: false }, { id: 'cat', name: '猫', mark: '猫', custom: false },
  { id: 'daily', name: '日用', mark: '用', custom: false }, { id: 'snack', name: '零食', mark: '零', custom: false },
  { id: 'charge', name: '充电', mark: '电', custom: false }, { id: 'cloth', name: '衣物', mark: '衣', custom: false },
  { id: 'fun', name: '娱乐', mark: '娱', custom: false }, { id: 'other', name: '其他', mark: '杂', custom: false }
]);
const SCENARIOS = Object.freeze({ 省: 4829, 中: 5519, 松: 6373 });

function allocationForMode(dailyBudget, mode) {
  return mode === 'three-day' ? dailyBudget * 3 : dailyBudget;
}

function progressToTarget(balance, target) {
  if (!Number.isInteger(balance) || !Number.isInteger(target) || target <= 0) throw new TypeError('balance and target must be positive integer cents');
  return Math.max(0, Math.min(100, (balance / target) * 100));
}

function daysUntil(deadline, from = new Date()) {
  const [year, month, day] = deadline.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  const current = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.ceil((target - current) / 86400000);
}

const PERIOD_INPUTS = Object.freeze([
  ['2026-09-24', '2026-09-25', '2026-08-21', '2026-09-20', '2026-10-22', 29, 0],
  ['2026-10-23', '2026-10-25', '2026-09-21', '2026-10-20', '2026-11-24', 33, 0],
  ['2026-11-25', '2026-11-25', '2026-10-21', '2026-11-20', '2026-12-24', 30, 0],
  ['2026-12-25', '2026-12-25', '2026-11-21', '2026-12-20', '2027-01-24', 31, 40588],
  ['2027-01-25', '2027-01-25', '2026-12-21', '2027-01-20', '2027-02-05', 12, 4340]
]);

// 已执行期次的四笔划转金额以流水为准。
// 预算情景（每日额度）是“往后怎么花”的决定，改它不该追溯改写已经发生的转账；
// 否则切一次情景就会让已封账/已执行的期次凭空对不上账。
function executedPaydayTotals(transfers, periods = derivePeriods()) {
  const list = Array.isArray(transfers) ? transfers : [];
  const total = (date, kind) => list.reduce((sum, item) => (item.date === date && item.kind === kind ? sum + item.amount : sum), 0);
  const executed = {};
  periods.forEach(item => {
    const income = total(item.payDate, 'payday_income');
    if (!income) return;
    executed[item.index] = {
      totalIn: income,
      billTotal: total(item.payDate, 'bill_repay'),
      budgetToPool: total(item.payDate, 'payday_budget'),
      saveToPocket: total(item.payDate, 'payday_save')
    };
  });
  return executed;
}

function derivePeriods({ dailyBudget = CONFIG.dailyBudget, executed = null } = {}) {
  let pocket = 0;
  return PERIOD_INPUTS.map((input, index) => {
    const [payDate, nominalPayDate, workStart, workEnd, rangeEnd, days, specialOut] = input;
    const workDays = countPayableWorkdays(workStart, workEnd);
    const salary = workDays * CONFIG.salaryPerDay;
    const allowance = CONFIG.monthlyAllowance;
    const planTotalIn = salary + allowance;
    const planBudgetToPool = days * dailyBudget;
    // 转入小荷包的金额不扣专项；专项是随后从③支付的计划内支出。
    // 因此 pocketAfter = 上期余额 + payday_save - special_out。
    const actual = executed ? executed[index + 1] : null;
    const totalIn = actual ? actual.totalIn : planTotalIn;
    const billTotal = actual ? actual.billTotal : BILL_TOTALS[index];
    const budgetToPool = actual ? actual.budgetToPool : planBudgetToPool;
    const saveToPocket = actual ? actual.saveToPocket : totalIn - billTotal - budgetToPool;
    pocket += saveToPocket - specialOut;
    return { index: index + 1, payDate, nominalPayDate, rangeStart: payDate, rangeEnd, days, workDays, salary, allowance, totalIn, billTotal, budgetToPool, saveToPocket, specialOut, pocketAfter: pocket, executed: Boolean(actual) };
  });
}

// 期次是纯派生数据：任何时刻都按“当前情景 + 已执行流水”重算，不留第二套口径。
function periodsForState(state) {
  const config = (state && state.config) || {};
  const dailyBudget = Number.isInteger(config.dailyBudget) ? config.dailyBudget : CONFIG.dailyBudget;
  const transfers = state && state.ledger ? state.ledger.transfers : [];
  return derivePeriods({ dailyBudget, executed: executedPaydayTotals(transfers) });
}

// 计划区间之外（未开始 / 已结束）返回 null，避免把任意日期都当成第 1 期。
function periodForDate(date, periods = derivePeriods()) {
  return periods.find(item => date >= item.rangeStart && date <= item.rangeEnd) || null;
}

function isPlanStarted(date, startDate = CONFIG.startDate) { return date >= startDate; }

function isPlanEnded(date, deadline = CONFIG.deadline) { return date > deadline; }

function isPlanActive(date, startDate = CONFIG.startDate, deadline = CONFIG.deadline) {
  return date >= startDate && date <= deadline;
}

function daysFrom(start, date) {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [dy, dm, dd] = date.split('-').map(Number);
  return Math.floor((Date.UTC(dy, dm - 1, dd) - Date.UTC(sy, sm - 1, sd)) / 86400000);
}

function createInitialState() {
  return { version: 1, schemaVersion: 4, config: { ...CONFIG, scenario: '中' }, periods: derivePeriods(), mode: 'daily', categories: DEFAULT_CATEGORIES, openingBalances: { BANK1: 0, POOL2: 0, POCKET3: 0, BILL: 0, OUT: 0 }, daySlots: {}, paydaySteps: {}, executedPaydays: {}, ledger: { expenses: [], transfers: [], specials: [], adjusts: [] } };
}

module.exports = { CONFIG, BILL_TOTALS, DEFAULT_CATEGORIES, SCENARIOS, allocationForMode, progressToTarget, daysUntil, derivePeriods, executedPaydayTotals, periodsForState, periodForDate, isPlanStarted, isPlanEnded, isPlanActive, daysFrom, createInitialState };
