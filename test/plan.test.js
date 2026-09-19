const test = require('node:test');
const assert = require('node:assert/strict');
const { yuanToFen, formatFen } = require('../miniprogram/domain/money');
const { countPayableWorkdays } = require('../miniprogram/domain/calendar');
const { CONFIG, derivePeriods, allocationForMode, progressToTarget, daysUntil, periodForDate, isPlanStarted, isPlanActive, daysFrom } = require('../miniprogram/domain/plan');
const { createExpense, createTransfer, remainingDailyBudget, dailySeries, accountBalances, sum, ACCT } = require('../miniprogram/domain/ledger');
const store = require('../miniprogram/store/store');
const { migrate, SCHEMA_VERSION } = require('../miniprogram/utils/storage');
const { exportLedgerCsv } = require('../miniprogram/utils/csv');
const { exportPaydayIcs } = require('../miniprogram/utils/ics');

test('金额使用整数分并正确格式化', () => {
  assert.equal(yuanToFen(55.19), 5519);
  assert.equal(formatFen(1199174), '11991.74');
});

test('节假日与调休工作日核算正确', () => {
  assert.equal(countPayableWorkdays('2026-08-21', '2026-09-20'), 22);
  assert.equal(countPayableWorkdays('2026-09-21', '2026-10-20'), 17);
  assert.equal(countPayableWorkdays('2026-12-21', '2027-01-20'), 22);
});

test('五期派生数字与 plan 硬验收标准一致', () => {
  const periods = derivePeriods();
  assert.deepEqual(periods.map(item => item.workDays), [22, 17, 23, 20, 22]);
  assert.deepEqual(periods.map(item => item.days), [29, 33, 30, 31, 12]);
  assert.deepEqual(periods.map(item => item.saveToPocket), [185517, 135212, 286601, 245259, 391513]);
  assert.deepEqual(periods.map(item => item.pocketAfter), [185517, 320729, 607330, 812001, 1199174]);
  assert.equal(periods.reduce((sum, item) => sum + item.specialOut, 0), 44928);
  assert.equal(periods.at(-1).pocketAfter, CONFIG.targetSavings);
});

test('流水按分聚合，日额度不产生浮点误差', () => {
  const expenses = [createExpense({ id: 'a', date: '2026-09-24', category: 'meal', amount: 1500 })];
  assert.equal(remainingDailyBudget(expenses, '2026-09-24', CONFIG.dailyBudget), 4019);
});

test('旧 storage 可以迁移到当前 schema', () => {
  const state = migrate({ config: CONFIG, ledger: { expenses: [] } });
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(state.ledger.transfers, []);
  assert.equal(state.categories.length, 8);
});

test('账本可以导出为带 BOM 的 CSV', () => {
  const csv = exportLedgerCsv({ categories: [{ id: 'meal', name: '吃饭' }], ledger: { expenses: [{ date: '2026-09-12', category: 'meal', amount: 1500, note: '午饭,面' }], transfers: [], adjusts: [] } });
  assert.ok(csv.startsWith('\ufeff日期,类型'));
  assert.match(csv, /"午饭,面"/);
});

test('三天一结的单次额度按三日计算', () => {
  assert.equal(allocationForMode(CONFIG.dailyBudget, 'daily'), 5519);
  assert.equal(allocationForMode(CONFIG.dailyBudget, 'three-day'), 16557);
});

test('储蓄进度和截止日倒计时计算稳定', () => {
  assert.equal(progressToTarget(500000, 1000000), 50);
  assert.equal(daysUntil('2026-09-13', new Date('2026-09-12T12:00:00')), 1);
});

test('本期每日柱状数据按日期生成', () => {
  const expenses = [createExpense({ id: 'a', date: '2026-09-24', category: 'meal', amount: 6000 })];
  const series = dailySeries(expenses, '2026-09-24', 2, { budget: 5519 });
  assert.deepEqual(series.map(item => item.date), ['2026-09-24', '2026-09-25']);
  assert.equal(series[0].over, true);
  assert.equal(series[1].used, false);
});

test('账户余额由划转和支出流水派生', () => {
  const transfer = createTransfer({ id: 't', date: '2026-09-12', from: ACCT.BANK1, to: ACCT.POCKET3, amount: 10000, kind: 'payday_save' });
  const expense = createExpense({ id: 'e', date: '2026-09-12', category: 'meal', amount: 1500 });
  const balances = accountBalances([transfer], [expense], { BANK1: 50000, POOL2: 0, POCKET3: 0, BILL: 0, OUT: 0 });
  assert.equal(balances.BANK1, 38500);
  assert.equal(balances.POCKET3, 10000);
  assert.equal(balances.OUT, 1500);
});

test('超支时只为新增超支额生成余额宝补差划转', () => {
  global.wx = {
    getStorageSync: () => null,
    setStorageSync: () => {},
    removeStorageSync: () => {}
  };
  store.reset();
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 60 });
  let transfers = store.getState().ledger.transfers.filter(item => item.kind === 'overspend_cover');
  assert.deepEqual(transfers.map(item => item.amount), [481]);
  store.addExpense({ date: '2026-09-24', category: 'snack', amountYuan: 5 });
  transfers = store.getState().ledger.transfers.filter(item => item.kind === 'overspend_cover');
  assert.deepEqual(transfers.map(item => item.amount), [481, 500]);
});

test('自动期次和 ICS 发薪提醒可派生', () => {
  assert.equal(periodForDate('2026-10-23').index, 2);
  assert.match(exportPaydayIcs(derivePeriods()), /BEGIN:VCALENDAR/);
  assert.match(exportPaydayIcs(derivePeriods()), /20260924/);
});

test('计划从 2026-09-24 开始，之前不应记账', () => {
  assert.equal(isPlanStarted('2026-09-12'), false);
  assert.equal(isPlanStarted('2026-09-24'), true);
  assert.equal(daysFrom('2026-09-24', '2026-09-27'), 3);
});

test('发薪执行和专项支出会写入可追溯流水', () => {
  global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} };
  store.reset();
  assert.equal(store.executePayday(1, '2026-09-23').blocked, 'not_reached');
  const payday = store.executePayday(1, '2026-09-24');
  assert.equal(payday.state.ledger.transfers.filter(item => item.kind === 'payday_save').length, 1);
  assert.equal(store.executePayday(1).alreadyExecuted, true);
  store.addSpecial({ date: '2026-12-25', reason: 'Q4水电', amountYuan: 405.88 });
  assert.equal(store.getState().ledger.specials[0].amount, 40588);
});

test('预算情景切换会重算每日额度和五期预算', () => {
  store.setScenario('省');
  assert.equal(store.getState().config.dailyBudget, 4829);
  assert.equal(store.getState().periods[0].budgetToPool, 4829 * 29);
  store.setScenario('中');
});

test('旧数据迁移会补回计划开始日', () => {
  const migrated = migrate({ config: { dailyBudget: 5519 }, ledger: { expenses: [], transfers: [], adjusts: [] } });
  assert.equal(migrated.config.startDate, '2026-09-24');
  assert.equal(migrated.periods.length, 5);
});

test('当天花 30 元会把 25.19 元退回预算池', () => {
  global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} };
  store.reset();
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 30 });
  const result = store.settleDay({ date: '2026-09-24', dailyBudget: 5519 });
  assert.equal(result.transfer.amount, 2519);
  assert.equal(result.state.daySlots['2026-09-24'].refunded, 2519);
});

test('三天一结前两天不退款，第三天按批次退款', () => {
  global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} };
  store.reset();
  store.setMode('three-day');
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 30 });
  store.addExpense({ date: '2026-09-25', category: 'meal', amountYuan: 20 });
  assert.equal(store.settleDay({ date: '2026-09-25', dailyBudget: 5519 }).batchPending, true);
  const result = store.settleDay({ date: '2026-09-26', dailyBudget: 5519 });
  assert.equal(result.transfer.amount, 11557);
});

test('当前日期可自动定位到对应期次，计划区间外不再冒充第 1 期', () => {
  assert.equal(periodForDate('2026-11-26', derivePeriods()).index, 3);
  assert.equal(periodForDate('2026-09-12', derivePeriods()), null);
  assert.equal(periodForDate('2030-01-01', derivePeriods()), null);
});

test('预算情景最终目标随日额度动态变化', () => {
  assert.equal(derivePeriods({ dailyBudget: 4829 }).at(-1).pocketAfter, 1292324);
  assert.equal(derivePeriods({ dailyBudget: 5519 }).at(-1).pocketAfter, 1199174);
  assert.equal(derivePeriods({ dailyBudget: 6373 }).at(-1).pocketAfter, 1083884);
});

const balancesOf = state => accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);
const refundsOf = state => state.ledger.transfers.filter(item => item.kind === 'daily_refund');
const coverOf = state => state.ledger.transfers.filter(item => item.kind === 'overspend_cover');
// 不变量：余额宝的余额 = 发薪日拨入的预算 −（已划入工资卡的额度 + 已补的超支），结算退款不得重复扣池子。
const poolContribution = state => state.periods[0].budgetToPool
  - sum(state.ledger.transfers, item => (item.kind === 'daily_alloc' || item.kind === 'overspend_cover') && item.date <= '2026-10-22');
const useMemoryStorage = () => { global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} }; };

test('“省”情景下晚间结算按当前日额度退款，而不是硬编码 55.19', () => {
  useMemoryStorage();
  store.reset();
  store.setScenario('省');
  store.executePayday(1, '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 30 });
  const result = store.settleDay({ date: '2026-09-24' });
  assert.equal(result.transfer.amount, 4829 - 3000);
  store.setScenario('中');
});

test('撤销封账会先撤销该批次的退款，再结算不会重复退回余额宝', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 30 });
  assert.equal(store.settleDay({ date: '2026-09-24' }).transfer.amount, 2519);
  const reopened = store.reopenDay('2026-09-24');
  assert.equal(reopened.reversedRefund, 2519);
  assert.equal(refundsOf(reopened.state).length, 0);
  assert.equal(balancesOf(reopened.state).POOL2, reopened.state.periods[0].budgetToPool - 5519);
  store.addExpense({ date: '2026-09-24', category: 'snack', amountYuan: 5 });
  const second = store.settleDay({ date: '2026-09-24' });
  assert.equal(second.transfer.amount, 2019);
  assert.deepEqual(refundsOf(second.state).map(item => item.amount), [2019]);
});

test('三天一结按批次额度判断超支，不再按单日额度补差', () => {
  useMemoryStorage();
  store.reset();
  store.setMode('three-day');
  store.executePayday(1, '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 80 });
  assert.deepEqual(coverOf(store.getState()).map(item => item.amount), []);
  store.addExpense({ date: '2026-09-25', category: 'fun', amountYuan: 90 });
  assert.deepEqual(coverOf(store.getState()).map(item => item.amount), [443]);
  const settled = store.settleDay({ date: '2026-09-26' });
  assert.equal(settled.transfer, null, '批次花完就不该再退钱');
  assert.equal(balancesOf(settled.state).POOL2, poolContribution(settled.state), '余额宝只为该批次出过一次 165.57');
  assert.equal(balancesOf(settled.state).BANK1, 0, '补差刚好把批次花红填平，卡上不多不少');
});

test('超支补差与晚间结算不会重复扣余额宝', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 60 });
  store.addExpense({ date: '2026-09-24', category: 'snack', amountYuan: 5 });
  const result = store.settleDay({ date: '2026-09-24' });
  assert.equal(result.transfer, null);
  assert.equal(balancesOf(result.state).POOL2, poolContribution(result.state));
  assert.equal(balancesOf(result.state).BANK1, 0);
});

test('计划开始日之前不允许结算，避免凭空退款', () => {
  useMemoryStorage();
  store.reset();
  const result = store.settleDay({ date: '2026-09-20' });
  assert.equal(result.blocked, 'not_started');
  assert.equal(result.transfer, null);
  assert.equal(balancesOf(result.state).POOL2, 0);
});

test('已封账的日期不能再次早间划额', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.settleDay({ date: '2026-09-24' });
  assert.equal(store.allocateDay({ date: '2026-09-24' }).blocked, 'closed');
});

test('同一毫秒内的多笔流水不会撞到相同 id', () => {
  useMemoryStorage();
  store.reset();
  const realNow = Date.now;
  Date.now = () => 1700000000000;
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 10 });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 10 });
  Date.now = realNow;
  const ids = store.getState().ledger.expenses.map(item => item.id);
  assert.equal(new Set(ids).size, 2);
});

test('元转分不丢浮点精度', () => {
  assert.equal(yuanToFen('1.005'), 101);
  assert.equal(yuanToFen(8.2), 820);
  assert.equal(yuanToFen('0.07'), 7);
});

test('缓存期次与当前日额度不一致时迁移会重算', () => {
  const stale = { config: { dailyBudget: 4829, scenario: '省' }, ledger: { expenses: [], transfers: [] }, periods: derivePeriods({ dailyBudget: 5519 }) };
  const migrated = migrate(stale);
  assert.equal(migrated.config.dailyBudget, 4829);
  assert.equal(migrated.periods[0].budgetToPool, 4829 * 29);
});

test('ICS 使用 CRLF 并带 UID/DTEND，可被系统日历接受', () => {
  const ics = exportPaydayIcs(derivePeriods());
  assert.ok(ics.includes('\r\n'));
  assert.match(ics, /UID:55kuai2-period-1@tally-book/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260924/);
  assert.match(ics, /DTEND;VALUE=DATE:20260925/);
});

test('金额校准差额会参与账户余额派生', () => {
  useMemoryStorage();
  store.reset();
  const result = store.addAdjust({ date: '2026-09-24', acct: ACCT.BANK1, realBalanceYuan: 100, bookBalanceYuan: 80 });
  assert.equal(result.state.ledger.adjusts[0].diff, 2000);
  assert.equal(balancesOf(result.state).BANK1, 2000);
});

test('计划截止日后禁止产生新的计划流水', () => {
  useMemoryStorage();
  store.reset();
  assert.equal(store.addExpense({ date: '2026-09-23', category: 'meal', amountYuan: 1 }).blocked, 'not_started');
  assert.equal(isPlanActive('2027-02-05'), true);
  assert.equal(isPlanActive('2027-02-06'), false);
  assert.equal(store.addExpense({ date: '2027-02-06', category: 'meal', amountYuan: 1 }).blocked, 'ended');
  assert.equal(store.allocateDay({ date: '2027-02-06' }).blocked, 'ended');
  assert.equal(store.settleDay({ date: '2027-02-06' }).blocked, 'ended');
  assert.equal(store.addSpecial({ date: '2027-02-06', reason: '计划外', amountYuan: 1 }).blocked, 'ended');
});

test('有未结三日批次时不能切换结算模式', () => {
  useMemoryStorage();
  store.reset();
  store.setMode('three-day', '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  const blocked = store.setMode('daily', '2026-09-25');
  assert.equal(blocked.blocked, 'active_batch');
  assert.equal(blocked.settlementDate, '2026-09-26');
  assert.equal(store.getState().mode, 'three-day');
  store.settleDay({ date: '2026-09-26' });
  assert.equal(store.setMode('daily', '2026-09-26').state.mode, 'daily');
});

test('每日模式只能在三日批次首日切换为三天一结', () => {
  useMemoryStorage();
  store.reset();
  assert.equal(store.setMode('three-day', '2026-09-25').blocked, 'batch_boundary');
  assert.equal(store.setMode('three-day', '2026-09-24').state.mode, 'three-day');
});

test('最后一个三日批次可在计划截止日正常结算', () => {
  useMemoryStorage();
  store.reset();
  store.setMode('three-day', '2026-09-24');
  store.allocateDay({ date: '2027-02-03' });
  assert.equal(store.settleDay({ date: '2027-02-04' }).settlementDate, '2027-02-05');
  const result = store.settleDay({ date: '2027-02-05' });
  assert.equal(result.transfer.amount, CONFIG.dailyBudget * 3);
});

test('未实际划额时结算不能凭空退款', () => {
  for (const mode of ['daily', 'three-day']) {
    useMemoryStorage();
    store.reset();
    store.setMode(mode, '2026-09-24');
    const result = store.settleDay({ date: mode === 'daily' ? '2026-09-24' : '2026-09-26' });
    assert.equal(result.transfer, null);
    assert.equal(balancesOf(result.state).BANK1, 0);
    assert.equal(balancesOf(result.state).POOL2, 0);
  }
});

test('三日批次封账后所有日期均禁止补记支出和重复划额', () => {
  useMemoryStorage();
  store.reset();
  store.setMode('three-day', '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.settleDay({ date: '2026-09-26' });
  for (const date of ['2026-09-24', '2026-09-25', '2026-09-26']) {
    assert.equal(store.addExpense({ date, category: 'meal', amountYuan: 10 }).blocked, 'closed');
    assert.equal(store.allocateDay({ date }).blocked, 'closed');
  }
});

test('切换模式后撤销封账和重结仍使用原三日批次', () => {
  useMemoryStorage();
  store.reset();
  store.setMode('three-day', '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 30 });
  const first = store.settleDay({ date: '2026-09-26' });
  assert.equal(first.transfer.amount, 13557);
  store.setMode('daily', '2026-09-26');
  const reopened = store.reopenDay('2026-09-25');
  assert.equal(reopened.reversedRefund, 13557);
  assert.equal(refundsOf(reopened.state).length, 0);
  assert.equal(store.allocateDay({ date: '2026-09-25' }).alreadyAllocated, true);
  store.addExpense({ date: '2026-09-25', category: 'meal', amountYuan: 20 });
  assert.equal(store.settleDay({ date: '2026-09-25' }).batchPending, true);
  const result = store.settleDay({ date: '2026-09-26' });
  assert.equal(result.transfer.amount, 11557);
  assert.equal(balancesOf(result.state).BANK1, 0);
  assert.equal(balancesOf(result.state).POOL2, -5000);
});
