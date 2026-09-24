const { countPayableWorkdays } = require('./calendar');

const CONFIG = Object.freeze({
  startDate: '2026-09-24',
  dailyBudget: 5519,
  salaryPerDay: 15000,
  monthlyAllowance: 200000,
  // 生活费预计到账日：只用于提醒与展示，实际以登记当天为准（store.registerAllowance）。
  allowanceExpectedDay: 28,
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

// 生活费预计到账日：工资日所在月的固定日（默认 28 日）。
function allowanceExpectedDate(payDate, expectedDay = CONFIG.allowanceExpectedDay) {
  const [year, month] = String(payDate).split('-');
  return `${year}-${month}-${String(expectedDay).padStart(2, '0')}`;
}

// 期次流水的归属：工资与生活费分两段到账后，业务日期不再能唯一定位期次，所以新流水统一带 periodIndex；
// 旧流水没有标签，按「业务日期 = 发薪日」归属，生活费再补一层「落在本期区间内」的兜底。
const PERIOD_KINDS = Object.freeze({
  payday_income: 'salary',
  allowance_income: 'allowance',
  bill_repay: 'bill',
  payday_budget: 'pool',
  payday_save: 'save'
});

function emptyTotals(index, input) {
  return {
    index, payDate: input[0], rangeStart: input[0], rangeEnd: input[4],
    planSalary: countPayableWorkdays(input[2], input[3]) * CONFIG.salaryPerDay,
    salaryIn: 0, allowanceIn: 0, allowanceDate: '', allowanceTagged: false, legacyMerged: false,
    billPlaced: 0, poolPlaced: 0, savePlaced: 0,
    salaryReceived: false, allowanceReceived: false
  };
}

// 把账本里的期次流水（工资 / 生活费 / 还账单 / 入池 / 转存）汇总到每一期。
// 纯派生、不改流水：重复登记、情景切换都不会在这里动到历史。
function periodIncomeTotals(transfers) {
  const list = Array.isArray(transfers) ? transfers : [];
  const totals = {};
  PERIOD_INPUTS.forEach((input, index) => { totals[index + 1] = emptyTotals(index + 1, input); });
  const periods = Object.keys(totals).map(key => totals[key]);
  const byIndex = new Map(periods.map(item => [item.index, item]));
  const byPayDate = new Map(periods.map(item => [item.payDate, item]));
  list.forEach(item => {
    const field = PERIOD_KINDS[item.kind];
    if (!field) return;
    // 优先认 periodIndex（新流水）；旧流水按发薪日匹配；再兜底按业务日期落在哪一期内。
    const target = Number.isInteger(item.periodIndex) && byIndex.has(item.periodIndex)
      ? byIndex.get(item.periodIndex)
      : (byPayDate.get(item.date) || periods.find(period => item.date >= period.rangeStart && item.date <= period.rangeEnd));
    if (!target) return;
    if (field === 'salary') target.salaryIn += item.amount;
    else if (field === 'allowance') {
      target.allowanceIn += item.amount;
      target.allowanceTagged = true;
      target.allowanceDate = item.date;
    } else if (field === 'bill') target.billPlaced += item.amount;
    else if (field === 'pool') target.poolPlaced += item.amount;
    else target.savePlaced += item.amount;
  });
  periods.forEach(period => {
    // 旧版「一笔合并入账」兼容：超出计划工资的部分就是当月生活费（固定 2,000，同日到账）。
    if (!period.allowanceTagged && period.salaryIn > period.planSalary) {
      period.allowanceIn = period.salaryIn - period.planSalary;
      period.salaryIn = period.planSalary;
      period.allowanceDate = period.payDate;
      period.legacyMerged = true;
    }
    period.salaryReceived = period.salaryIn > 0;
    period.allowanceReceived = period.allowanceTagged || period.allowanceIn > 0;
  });
  return totals;
}

// 收入安置的唯一算法：账单 → 预算池 → 储蓄。
// 只看「这笔到账的钱到来时，各目标还差多少」，所以任何时候都不会安置超出到账额的钱，
// 也永远不会写出负数划转；重复登记时缺口已被流水抵消，天然幂等。
function placementFor(period, freeFen) {
  if (!Number.isInteger(freeFen) || freeFen < 0) throw new TypeError('freeFen must be a non-negative integer');
  let free = freeFen;
  const bill = Math.min(free, Math.max(0, period.billTotal - period.billPlaced));
  free -= bill;
  const pool = Math.min(free, Math.max(0, period.budgetToPool - period.poolPlaced));
  free -= pool;
  return { bill, pool, save: free };
}

// 期次是纯派生数据：两笔收入（工资 + 生活费）都到齐的期次以流水为准，
// 尚未到齐的期次仍按当前情景展示计划值，并把「已安置 / 还差多少」一并给出。
function derivePeriods({ dailyBudget = CONFIG.dailyBudget, allowanceExpectedDay = CONFIG.allowanceExpectedDay, ledgerTotals = null } = {}) {
  let pocket = 0;
  return PERIOD_INPUTS.map((input, index) => {
    const [payDate, nominalPayDate, workStart, workEnd, rangeEnd, days, specialOut] = input;
    const workDays = countPayableWorkdays(workStart, workEnd);
    const salary = workDays * CONFIG.salaryPerDay;
    const allowance = CONFIG.monthlyAllowance;
    const planTotalIn = salary + allowance;
    const planBill = BILL_TOTALS[index];
    const planBudget = days * dailyBudget;
    const planSave = planTotalIn - planBill - planBudget;
    const totals = (ledgerTotals && ledgerTotals[index + 1]) || emptyTotals(index + 1, input);
    const salaryReceived = Boolean(totals.salaryReceived);
    const allowanceReceived = Boolean(totals.allowanceReceived);
    const fullyFunded = salaryReceived && allowanceReceived;
    // 计划表假设预算会被花光（saveToPocket = totalIn − bill − budgetToPool）；
    // 两笔收入都到齐后改用流水事实，情景切换不再追溯改写已经发生的划转。
    const totalIn = fullyFunded ? totals.salaryIn + totals.allowanceIn : planTotalIn;
    const billTotal = fullyFunded ? totals.billPlaced : planBill;
    const budgetToPool = fullyFunded ? totals.poolPlaced : planBudget;
    const saveToPocket = fullyFunded ? totals.savePlaced : planSave;
    pocket += saveToPocket - specialOut;
    const period = {
      index: index + 1, payDate, nominalPayDate, rangeStart: payDate, rangeEnd, days, workDays,
      salary, allowance, totalIn, billTotal, budgetToPool, saveToPocket, specialOut, pocketAfter: pocket,
      executed: salaryReceived,
      salaryIn: totals.salaryIn, allowanceIn: totals.allowanceIn,
      salaryReceived, allowanceReceived, fullyFunded, legacyMerged: Boolean(totals.legacyMerged),
      allowanceDate: totals.allowanceDate || '', allowanceExpectedDate: allowanceExpectedDate(payDate, allowanceExpectedDay),
      billPlaced: totals.billPlaced, poolPlaced: totals.poolPlaced, savePlaced: totals.savePlaced,
      planBill, planBudget, planSave,
      pendingBill: Math.max(0, planBill - totals.billPlaced),
      pendingPool: Math.max(0, planBudget - totals.poolPlaced),
      pendingSave: Math.max(0, planSave - totals.savePlaced),
      unplacedFen: Math.max(0, totals.salaryIn + totals.allowanceIn - totals.billPlaced - totals.poolPlaced - totals.savePlaced)
    };
    // 工资已登记、生活费未到：给出「生活费到账后将如何安置」的纯预览，供发薪日页显示待办金额。
    period.allowancePlan = salaryReceived && !allowanceReceived ? placementFor(period, allowance) : null;
    return period;
  });
}

function periodsForState(state) {
  const config = (state && state.config) || {};
  const dailyBudget = Number.isInteger(config.dailyBudget) ? config.dailyBudget : CONFIG.dailyBudget;
  const allowanceExpectedDay = Number.isInteger(config.allowanceExpectedDay) ? config.allowanceExpectedDay : CONFIG.allowanceExpectedDay;
  const transfers = state && state.ledger ? state.ledger.transfers : [];
  return derivePeriods({ dailyBudget, allowanceExpectedDay, ledgerTotals: periodIncomeTotals(transfers) });
}

// 余额宝里“本周期用不完”的钱 = 余额 −（剩余天数 × 当前情景日额度）。
// 这就是发薪日 SOP 第六步「清理上期结余」该真实转进小荷包的金额：
// 计划表假设预算会被花光（saveToPocket = totalIn − bill − budgetToPool），
// 没花完的余粮、以及改小情景后多出来的额度，都只会躺在余额宝里，不计入储蓄。
function poolSurplus({ poolBalance, dailyBudget, asOfDate, rangeEnd, daySettled = false }) {
  if (!Number.isInteger(poolBalance) || !Number.isInteger(dailyBudget)) throw new TypeError('poolSurplus needs integer cents');
  // 今天所在的批次已封账 → 今天不用再预留额度（未花的钱已经退回余额宝，属于余粮）；
  // 这样截止日当天结完账，最后一期的余粮也还能清干净。
  const days = Math.max(0, daysFrom(asOfDate, rangeEnd) + (daySettled ? 0 : 1));
  const needed = days * dailyBudget;
  return { remainingDays: days, needed, surplus: Math.max(0, poolBalance - needed) };
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
  return { version: 1, schemaVersion: 5, config: { ...CONFIG, scenario: '中' }, periods: derivePeriods(), mode: 'daily', categories: DEFAULT_CATEGORIES, openingBalances: { BANK1: 0, POOL2: 0, POCKET3: 0, BILL: 0, OUT: 0 }, daySlots: {}, paydaySteps: {}, executedPaydays: {}, ledger: { expenses: [], transfers: [], specials: [], adjusts: [] } };
}

module.exports = { CONFIG, BILL_TOTALS, DEFAULT_CATEGORIES, SCENARIOS, allocationForMode, poolSurplus, progressToTarget, daysUntil, allowanceExpectedDate, periodIncomeTotals, placementFor, derivePeriods, periodsForState, periodForDate, isPlanStarted, isPlanEnded, isPlanActive, daysFrom, createInitialState };
