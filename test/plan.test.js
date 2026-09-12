const test = require('node:test');
const assert = require('node:assert/strict');
const { yuanToFen, formatFen } = require('../miniprogram/domain/money');
const { countPayableWorkdays } = require('../miniprogram/domain/calendar');
const { CONFIG, derivePeriods, allocationForMode, progressToTarget, daysUntil } = require('../miniprogram/domain/plan');
const { createExpense, remainingDailyBudget, dailySeries } = require('../miniprogram/domain/ledger');
const { migrate, SCHEMA_VERSION } = require('../miniprogram/utils/storage');
const { exportLedgerCsv } = require('../miniprogram/utils/csv');

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
  const series = dailySeries(expenses, '2026-09-24', 2);
  assert.deepEqual(series.map(item => item.date), ['2026-09-24', '2026-09-25']);
  assert.equal(series[0].over, true);
  assert.equal(series[1].used, false);
});
