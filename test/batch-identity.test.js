// 批次身份不变量：一天只属于一个批次，批次身份一旦登记就不再被“切换结算模式 + 事后改动历史”改写。
// 这条锁住的是一个真实的超退缺陷（v1.1.0 同样存在）：
// 单日批次已封账 → 之后切三天一结 → 冲正同一网格批次内的另一天 → 已封账批次被并进三日批次，
// 于是按 3 天额度重算“应退”，凭空多退一整天的额度，工资卡被搬走 96.58 元。
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../miniprogram/store/store');
const { accountBalances } = require('../miniprogram/domain/ledger');

const useMemoryStorage = () => { global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} }; };
const balancesOf = state => accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);

// 剧本：省情景下 11-22 单日封账；11-21 只记支出从未划额；之后切三天一结并冲正 11-21
function sealedDailyThenSwitch() {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  store.setScenario('省', '2026-11-20');
  store.allocateDay({ date: '2026-11-22' });
  store.addExpense({ date: '2026-11-22', category: 'meal', amountYuan: 30 });
  const sealed = store.settleDay({ date: '2026-11-22' });
  assert.equal(sealed.transfer.amount, 4829 - 3000, '单日批次按当天真实划入退款');
  store.addExpense({ date: '2026-11-21', category: 'snack', amountYuan: 10 });
  store.setMode('three-day', '2026-11-23');
  return sealed;
}

test('冲正未归批的历史日子，不会把已封账批次并进新的三日批次', () => {
  sealedDailyThenSwitch();
  const target = store.getState().ledger.expenses.find(item => item.date === '2026-11-21');
  const result = store.reverseExpense({ id: target.id, asOfDate: '2026-11-24' });
  assert.equal(result.blocked, undefined);
  assert.equal(result.trueUp, null, '11-21 所在批次从没划入过额度，不该产生补退');
  const slot = store.getState().daySlots['2026-11-22'];
  assert.equal(slot.batchStart, '2026-11-22', '已封账批次的身份不能被重新归批');
  assert.equal(slot.batchEnd, '2026-11-22');
  assert.equal(slot.batchMode, 'daily');
  assert.equal(slot.allocated, 4829);
  assert.equal(slot.refunded, 1829);
});

test('重新归批不再搬动工资卡的钱：冲正只是还原支出，不多退余额宝', () => {
  sealedDailyThenSwitch();
  const before = balancesOf(store.getState());
  assert.equal(before.BANK1, -1000, '11-21 那 10 元没划额，只能由工资卡自付');
  assert.equal(before.BANK1 + before.POOL2 + before.POCKET3 + before.BILL + before.OUT, 0);
  const target = store.getState().ledger.expenses.find(item => item.date === '2026-11-21');
  const result = store.reverseExpense({ id: target.id, asOfDate: '2026-11-24' });
  const after = balancesOf(result.state);
  assert.equal(after.BANK1, 0, '冲正把 10 元还原给工资卡，不欠账');
  assert.equal(after.POOL2, before.POOL2, '余额宝不该被多退一笔（v1.1.0 会凭空多收 96.58）');
  assert.equal(after.BANK1 + after.POOL2 + after.POCKET3 + after.BILL + after.OUT, 0);
});

test('候选批次只吞没“还没有批次身份”的日子，裁到相邻已归批日子之前', () => {
  sealedDailyThenSwitch();
  const target = store.getState().ledger.expenses.find(item => item.date === '2026-11-21');
  const result = store.reverseExpense({ id: target.id, asOfDate: '2026-11-24' });
  assert.equal(result.range.start, '2026-11-20', '11-20 还没有批次身份，可以并入');
  assert.equal(result.range.end, '2026-11-21', '但绝不能跨过已封账的 11-22');
  const slots = result.state.daySlots;
  assert.equal(Object.keys(slots).filter(key => slots[key].batchStart === '2026-11-20' && slots[key].batchEnd === '2026-11-22').length, 0, '不存在 11-20~11-22 这个批次');
  // 之后正常开新批次：照常按三日网格归批，且不会跨过已封账的老批次
  const fresh = store.allocateDay({ date: '2026-11-24' });
  assert.equal(fresh.transfer.amount, 4829 * 3, '11-23~11-25 是一个完整的三日批次');
  store.addExpense({ date: '2026-11-24', category: 'meal', amountYuan: 20 });
  const settled = store.settleDay({ date: '2026-11-25' });
  assert.equal(settled.transfer.amount, 4829 * 3 - 2000);
  const slots2 = settled.state.daySlots;
  assert.equal(slots2['2026-11-24'].batchStart, '2026-11-23');
  assert.equal(slots2['2026-11-24'].batchEnd, '2026-11-25');
  assert.equal(slots2['2026-11-22'].batchEnd, '2026-11-22', '老批次身份纹丝不动');
  assert.equal(balancesOf(settled.state).BANK1, -1829 + 1829 - 0, '工资卡只剩 11-22 那笔已结清的痕迹');
});

test('反向场景：三日批次封账后切每日，再动历史某天仍按原三日批次核算', () => {
  useMemoryStorage();
  store.reset();
  store.setMode('three-day', '2026-09-24');
  store.executePayday(1, '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-25', category: 'meal', amountYuan: 30 });
  const sealed = store.settleDay({ date: '2026-09-26' });
  assert.equal(sealed.transfer.amount, 16557 - 3000);
  store.setMode('daily', '2026-09-27');
  const target = store.getState().ledger.expenses.find(item => item.date === '2026-09-25');
  const result = store.reverseExpense({ id: target.id, asOfDate: '2026-09-27' });
  assert.equal(result.range.start, '2026-09-24', '仍归属原来的三日批次');
  assert.equal(result.range.end, '2026-09-26');
  assert.equal(result.trueUp.amount, 3000, '补退只算这个批次“应退 − 已退”的差额');
  assert.equal(balancesOf(result.state).BANK1, 0);
});
