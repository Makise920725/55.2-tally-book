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
const covers = state => state.ledger.transfers.filter(item => item.kind === 'overspend_cover').map(item => item.amount);

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

test('过去某天没划额还超支过：补划再结算，账能闭环', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  store.addExpense({ date: '2026-09-25', category: 'meal', amountYuan: 60 });
  assert.deepEqual(covers(store.getState()), [481], '未划额时只为超出 55.19 的部分补差');
  assert.equal(store.settleDay({ date: '2026-09-25' }).blocked, 'not_allocated');
  assert.equal(store.previewSettlement('2026-09-25').blocked, 'not_allocated');
  const preview = store.previewAllocation('2026-09-25');
  assert.equal(preview.amount, 5519);
  assert.equal(preview.allocationDate, '2026-09-25');
  assert.equal(preview.catchUp, false);
  store.allocateDay({ date: '2026-09-25' });
  const due = store.previewSettlement('2026-09-25');
  assert.equal(due.allocated, 5519);
  assert.equal(due.covered, 481);
  assert.equal(due.spent, 6000);
  assert.equal(due.due, 0, '划入 + 补差正好覆盖支出，没有余粮可退');
  const settled = store.settleDay({ date: '2026-09-25' });
  assert.equal(settled.transfer, null);
  assert.equal(settled.state.daySlots['2026-09-25'].closed, true);
  assert.equal(balancesOf(settled.state).BANK1, 0);
  assert.equal(balancesOf(settled.state).POOL2, 160051 - 5519 - 481);
});

test('预览与写入是同一口径：preview 报的数就是实际发生的那笔', () => {
  useMemoryStorage();
  store.reset();
  store.setMode('three-day', '2026-09-24');
  store.executePayday(1, '2026-09-24');
  store.addExpense({ date: '2026-09-25', category: 'meal', amountYuan: 40 });
  const allocation = store.previewAllocation('2026-09-26');
  assert.equal(allocation.amount, 16557);
  assert.equal(allocation.allocationDate, '2026-09-24');
  assert.equal(allocation.spanDays, 3);
  assert.equal(allocation.catchUp, true);
  const written = store.allocateDay({ date: '2026-09-26' });
  assert.equal(written.transfer.amount, allocation.amount);
  assert.equal(written.transfer.date, allocation.allocationDate);
  assert.equal(written.range.start, '2026-09-24');
  const pending = store.previewSettlement('2026-09-25');
  assert.equal(pending.batchPending, true);
  assert.equal(pending.settlementDate, '2026-09-26');
  const settlePreview = store.previewSettlement('2026-09-26');
  assert.equal(settlePreview.due, 12557);
  const settled = store.settleDay({ date: '2026-09-26' });
  assert.equal(settled.transfer.amount, settlePreview.due, '预览金额 = 实际退款金额');
});

test('已封账的日子：预览直接说明不能动', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 20 });
  store.settleDay({ date: '2026-09-24' });
  assert.equal(store.previewAllocation('2026-09-24').blocked, 'closed');
  assert.equal(store.previewSettlement('2026-09-24').alreadyClosed, true);
  assert.equal(store.getState().ledger.transfers.filter(item => item.kind === 'daily_alloc').length, 1);
});

test('补划沿用该批次已钉住的额度，不与已发生的超支补差打架', () => {
  useMemoryStorage();
  store.reset();
  store.setScenario('松', '2026-11-15');
  store.executePayday(1, '2026-09-24');
  // 11-16 没划额就花了 99 元：按松情景 63.73 的阈值，从余额宝补差 35.27
  store.addExpense({ date: '2026-11-16', category: 'meal', amountYuan: 89 });
  store.addExpense({ date: '2026-11-16', category: 'fun', amountYuan: 10 });
  assert.deepEqual(covers(store.getState()), [2527, 1000]);
  assert.equal(store.getState().daySlots['2026-11-16'].plannedBudget, 6373);
  // 之后改计划成「中」（55.19），再回头补划 11-16
  store.setScenario('中', '2026-11-17');
  const preview = store.previewAllocation('2026-11-16');
  assert.equal(preview.amount, 6373, '补划沿用批次钉住的 63.73，而不是新情景的 55.19');
  assert.equal(preview.fromPinnedBudget, true);
  const written = store.allocateDay({ date: '2026-11-16' });
  assert.equal(written.transfer.amount, preview.amount);
  const settled = store.settleDay({ date: '2026-11-16' });
  assert.equal(settled.transfer, null, '63.73 + 已补 35.27 正好覆盖 99 元支出，没有余粮可退');
  assert.equal(balancesOf(settled.state).BANK1, 0, '封账后工资卡必须归零，不能留下 8.54 的窟窿');
  assert.equal(settled.state.daySlots['2026-11-16'].closed, true);
});

test('补划沿用钉住额度时，多划的部分照常整批退回余额宝', () => {
  useMemoryStorage();
  store.reset();
  store.setScenario('松', '2026-11-15');
  store.executePayday(1, '2026-09-24');
  store.addExpense({ date: '2026-11-16', category: 'meal', amountYuan: 30 });
  store.setScenario('中', '2026-11-17');
  const written = store.allocateDay({ date: '2026-11-16' });
  assert.equal(written.transfer.amount, 6373, '该批次阈值已钉在 63.73');
  const preview = store.previewSettlement('2026-11-16');
  assert.equal(preview.due, 6373 - 3000);
  const settled = store.settleDay({ date: '2026-11-16' });
  assert.equal(settled.transfer.amount, preview.due);
  assert.equal(balancesOf(settled.state).BANK1, 0);
  assert.equal(covers(settled.state).length, 0, '没超支就不该有补差');
});
