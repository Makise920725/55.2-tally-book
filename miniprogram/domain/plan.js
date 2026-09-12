const { yuanToFen } = require('./money');
const { countPayableWorkdays } = require('./calendar');

const CONFIG = Object.freeze({
  dailyBudget: 5519,
  salaryPerDay: 15000,
  monthlyAllowance: 200000,
  goalMinimum: 1000000,
  targetSavings: 1199174,
  deadline: '2027-02-05'
});

const BILL_TOTALS = Object.freeze([184432, 137661, 92829, 83652, 72259]);
const DEFAULT_CATEGORIES = Object.freeze([
  { id: 'meal', name: '吃饭', mark: '食' }, { id: 'cat', name: '猫', mark: '猫' },
  { id: 'daily', name: '日用', mark: '用' }, { id: 'snack', name: '零食', mark: '零' },
  { id: 'charge', name: '充电', mark: '电' }, { id: 'cloth', name: '衣物', mark: '衣' },
  { id: 'fun', name: '娱乐', mark: '娱' }, { id: 'other', name: '其他', mark: '杂' }
]);

const PERIOD_INPUTS = Object.freeze([
  ['2026-09-24', '2026-09-25', '2026-08-21', '2026-09-20', '2026-10-22', 29, 0],
  ['2026-10-23', '2026-10-25', '2026-09-21', '2026-10-20', '2026-11-24', 33, 0],
  ['2026-11-25', '2026-11-25', '2026-10-21', '2026-11-20', '2026-12-24', 30, 0],
  ['2026-12-25', '2026-12-25', '2026-11-21', '2026-12-20', '2027-01-24', 31, 40588],
  ['2027-01-25', '2027-01-25', '2026-12-21', '2027-01-20', '2027-02-05', 12, 4340]
]);

function derivePeriods() {
  let pocket = 0;
  return PERIOD_INPUTS.map((input, index) => {
    const [payDate, nominalPayDate, workStart, workEnd, rangeEnd, days, specialOut] = input;
    const workDays = countPayableWorkdays(workStart, workEnd);
    const salary = workDays * CONFIG.salaryPerDay;
    const totalIn = salary + CONFIG.monthlyAllowance;
    const billTotal = BILL_TOTALS[index];
    const budgetToPool = days * CONFIG.dailyBudget;
    // 转入小荷包的金额不扣专项；专项是随后从③支付的计划内支出。
    // 因此 pocketAfter = 上期余额 + payday_save - special_out。
    const saveToPocket = totalIn - billTotal - budgetToPool;
    pocket += saveToPocket - specialOut;
    return { index: index + 1, payDate, nominalPayDate, rangeStart: payDate, rangeEnd, days, workDays, salary, allowance: CONFIG.monthlyAllowance, totalIn, billTotal, budgetToPool, saveToPocket, specialOut, pocketAfter: pocket };
  });
}

function createInitialState() {
  return { version: 1, schemaVersion: 4, config: CONFIG, periods: derivePeriods(), categories: DEFAULT_CATEGORIES, daySlots: {}, paydaySteps: {}, ledger: { expenses: [], transfers: [], adjusts: [] } };
}

module.exports = { CONFIG, BILL_TOTALS, DEFAULT_CATEGORIES, derivePeriods, createInitialState };
