// 划额（早间划额 / 批次补划）的口径：一个批次只划一次，金额按批次实际天数，
// 首日漏点可以在本批任意一天补上，流水仍落在批次首日。
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../miniprogram/store/store');
const { accountBalances } = require('../miniprogram/domain/ledger');
const { buildLedgerEvents, dayStatsByDate } = require('../miniprogram/domain/ledger-view');

const useMemoryStorage = () => { global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} }; };
const balancesOf = state => accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);
const allocs = state => state.ledger.transfers.filter(item => item.kind === 'daily_alloc').map(item => `${item.date}=${item.amount}`);

function startThreeDay() {
  useMemoryStorage();
  store.reset();
  store.setMode('three-day', '2026-09-24');
  store.executePayday(1, '2026-09-24');
}

test('三日批次首日漏划：第二天补划落在批次首日，第三批仍能正常封账', () => {
  startThreeDay();
  // 9-24 忘了点划额，只记了一笔支出
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 100 });
  assert.equal(store.settleDay({ date: '2026-09-24' }).blocked, 'not_allocated');
  const catchUp = store.allocateDay({ date: '2026-09-25' });
  assert.equal(catchUp.catchUp, true);
  assert.equal(catchUp.allocationDate, '2026-09-24', '补划的业务日期是批次首日');
  assert.equal(catchUp.transfer.date, '2026-09-24');
  assert.equal(catchUp.spanDays, 3);
  assert.equal(catchUp.transfer.amount, 5519 * 3);
  assert.deepEqual(allocs(store.getState()), ['2026-09-24=16557'], '一个批次只有一笔划额');
  const settled = store.settleDay({ date: '2026-09-26' });
  assert.equal(settled.transfer.amount, 16557 - 10000, '按批次额度退款，与补划发生在哪天无关');
  assert.equal(balancesOf(settled.state).BANK1, 0, '封账后工资卡归零');
  assert.equal(settled.state.daySlots['2026-09-25'].batchStart, '2026-09-24', '批次内每天都记住自己属于哪个批次');
});

test('补划不重复：已划入的批次再点只提示，已封账的批次禁止补划', () => {
  startThreeDay();
  assert.equal(store.allocateDay({ date: '2026-09-24' }).transfer.amount, 16557);
  const twice = store.allocateDay({ date: '2026-09-25' });
  assert.equal(twice.alreadyAllocated, true);
  assert.equal(twice.allocationDate, '2026-09-24');
  assert.deepEqual(allocs(store.getState()), ['2026-09-24=16557']);
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 10 });
  store.settleDay({ date: '2026-09-26' });
  assert.equal(store.allocateDay({ date: '2026-09-25' }).blocked, 'closed');
});

test('第三批当天才补划：当天结算不再卡在 not_allocated', () => {
  startThreeDay();
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 30 });
  store.addExpense({ date: '2026-09-26', category: 'snack', amountYuan: 20 });
  const catchUp = store.allocateDay({ date: '2026-09-26' });
  assert.equal(catchUp.catchUp, true);
  assert.equal(catchUp.transfer.date, '2026-09-24');
  const settled = store.settleDay({ date: '2026-09-26' });
  assert.equal(settled.transfer.amount, 16557 - 5000);
  assert.equal(balancesOf(settled.state).BANK1, 0);
  // 余额宝：本期入池 1600.51 → 划出 165.57 → 结算退回 115.57，一个批次只被扣一次额度
  assert.equal(balancesOf(settled.state).POOL2, 160051 - 16557 + 11557);
});

test('每日模式划额仍是当天一笔一天额度', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  const result = store.allocateDay({ date: '2026-09-24' });
  assert.equal(result.catchUp, undefined === result.catchUp ? undefined : false, '每日模式不算补划');
  assert.equal(result.transfer.date, '2026-09-24');
  assert.equal(result.transfer.amount, 5519);
  assert.equal(result.spanDays, 1);
});

test('截止日前的最后一个批次：补划落在批次首日，截止日当天仍能整批封账', () => {
  useMemoryStorage();
  store.reset();
  store.setMode('three-day', '2026-09-24');
  store.executePayday(5, '2027-01-25');
  const catchUp = store.allocateDay({ date: '2027-02-05' });
  assert.equal(catchUp.transfer.date, '2027-02-03', '2027-02-05 是最后批次的第 3 天，额度属于首日');
  assert.equal(catchUp.spanDays, 3);
  assert.equal(catchUp.transfer.amount, 5519 * 3);
  assert.equal(store.settleDay({ date: '2027-02-05' }).transfer.amount, 5519 * 3, '整批没花出去就整批退回余额宝');
  assert.equal(balancesOf(store.getState()).BANK1, 0);
});

test('补划的划额事件出现在批次首日，视图按批次日展示', () => {
  startThreeDay();
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 10 });
  store.allocateDay({ date: '2026-09-25' });
  const stats = dayStatsByDate(buildLedgerEvents(store.getState(), { startDate: '2026-09-24', endDate: '2026-09-26' }));
  assert.equal(stats['2026-09-24'].hasAlloc, true);
  assert.equal(stats['2026-09-24'].allocAmount, 16557);
  assert.ok(!stats['2026-09-25'] || !stats['2026-09-25'].hasAlloc, '划额不该挂在补划那天');
});
