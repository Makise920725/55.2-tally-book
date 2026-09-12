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

function derivePeriods({ dailyBudget = CONFIG.dailyBudget } = {}) {
  let pocket = 0;
  return PERIOD_INPUTS.map((input, index) => {
    const [payDate, nominalPayDate, workStart, workEnd, rangeEnd, days, specialOut] = input;
    const workDays = countPayableWorkdays(workStart, workEnd);
    const salary = workDays * CONFIG.salaryPerDay;
    const totalIn = salary + CONFIG.monthlyAllowance;
    const billTotal = BILL_TOTALS[index];
    const budgetToPool = days * dailyBudget;
    // 转入小荷包的金额不扣专项；专项是随后从③支付的计划内支出。
    // 因此 pocketAfter = 上期余额 + payday_save - special_out。
    const saveToPocket = totalIn - billTotal - budgetToPool;
    pocket += saveToPocket - specialOut;
    return { index: index + 1, payDate, nominalPayDate, rangeStart: payDate, rangeEnd, days, workDays, salary, allowance: CONFIG.monthlyAllowance, totalIn, billTotal, budgetToPool, saveToPocket, specialOut, pocketAfter: pocket };
  });
}

function periodForDate(date, periods = derivePeriods()) {
  return periods.find(item => date >= item.rangeStart && date <= item.rangeEnd) || periods[0];
}

function isPlanStarted(date, startDate = CONFIG.startDate) { return date >= startDate; }

function daysFrom(start, date) {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [dy, dm, dd] = date.split('-').map(Number);
  return Math.floor((Date.UTC(dy, dm - 1, dd) - Date.UTC(sy, sm - 1, sd)) / 86400000);
}

function createInitialState() {
  return { version: 1, schemaVersion: 4, config: { ...CONFIG, scenario: '中' }, mode: 'daily', categories: DEFAULT_CATEGORIES, openingBalances: { BANK1: 0, POOL2: 0, POCKET3: 0, BILL: 0, OUT: 0 }, daySlots: {}, paydaySteps: {}, executedPaydays: {}, ledger: { expenses: [], transfers: [], specials: [], adjusts: [] } };
}

module.exports = { CONFIG, BILL_TOTALS, DEFAULT_CATEGORIES, SCENARIOS, allocationForMode, progressToTarget, daysUntil, derivePeriods, periodForDate, isPlanStarted, daysFrom, createInitialState };
