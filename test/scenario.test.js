// 预算情景（省 / 中 / 松）与已封账数据的关系：
// 「先封账、再把计划从中改成省」不能改动任何已经发生的钱，只能改变未执行期次的计划口径。
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../miniprogram/store/store');
const { derivePeriods } = require('../miniprogram/domain/plan');
const { accountBalances } = require('../miniprogram/domain/ledger');
const { migrate } = require('../miniprogram/utils/storage');

const useMemoryStorage = () => { global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} }; };
const balancesOf = state => accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);
const covers = state => state.ledger.transfers.filter(item => item.kind === 'overspend_cover').map(item => item.amount);
const refunds = state => state.ledger.transfers.filter(item => item.kind === 'daily_refund').map(item => item.amount);
const firstExpenseId = state => state.ledger.expenses[0].id;

test('每日封账后改情景：余额一字不动，撤销封账再结算仍按当天真实划入退款', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 30 });
  assert.equal(store.settleDay({ date: '2026-09-24' }).transfer.amount, 2519);

  const before = balancesOf(store.getState());
  const transferCount = store.getState().ledger.transfers.length;
  const switched = store.setScenario('省', '2026-09-24');
  assert.deepEqual(balancesOf(switched.state), before, '切换情景不得写入或改动任何流水');
  assert.equal(switched.state.ledger.transfers.length, transferCount);

  const reopened = store.reopenDay('2026-09-24');
  assert.equal(reopened.reversedRefund, 2519);
  const again = store.settleDay({ date: '2026-09-24' });
  assert.equal(again.transfer.amount, 2519, '退款按实际划入的 55.19 计算，而不是新的 48.29');
});

test('已封账批次改情景后再冲正：补退仍等于误记金额', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 42 });
  store.settleDay({ date: '2026-09-24' });
  store.setScenario('省', '2026-09-24');
  const result = store.reverseExpense({ id: firstExpenseId(store.getState()), asOfDate: '2026-09-24' });
  assert.equal(result.blocked, undefined);
  assert.equal(result.trueUp.amount, 4200);
  assert.deepEqual(refunds(store.getState()), [1319, 4200]);
});

test('三日批次未结算时改情景：本批按实际划入结算，下一批才用新额度', () => {
  useMemoryStorage();
  store.reset();
  store.setMode('three-day', '2026-09-24');
  store.executePayday(1, '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 100 });
  const switched = store.setScenario('省', '2026-09-25');
  assert.equal(switched.state.config.dailyBudget, 4829);
  const settled = store.settleDay({ date: '2026-09-26' });
  assert.equal(settled.transfer.amount, 16557 - 10000, '批次退款看首日实际划入的 3×55.19');
  const next = store.allocateDay({ date: '2026-09-27' });
  assert.equal(next.transfer.amount, 4829 * 3, '新批次才按省情景划入');
});

test('改情景只重算未执行期次：已执行期次停在流水上，目标等于实际加未来计划', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  const plan = store.getState().periods;
  const switched = store.setScenario('省', '2026-10-23');
  const next = switched.state;
  assert.equal(next.periods[0].executed, true);
  assert.equal(next.periods[0].budgetToPool, plan[0].budgetToPool, '本期预算 = 余额宝真实收到的 payday_budget');
  assert.equal(next.periods[0].saveToPocket, plan[0].saveToPocket);
  assert.equal(next.periods[1].budgetToPool, 4829 * 33);
  assert.deepEqual(switched.frozen, [1]);
  assert.deepEqual(switched.replanned, [2, 3, 4, 5]);
  const expected = next.periods[0].saveToPocket
    + next.periods.slice(1).reduce((total, item) => total + item.saveToPocket - item.specialOut, 0);
  assert.equal(next.periods[4].pocketAfter, expected, '储蓄轨迹从实际余额往后接，而不是凭空抬高历史');
  assert.equal(next.config.targetSavings, expected, '目标储蓄额跟随真实轨迹');
  // 记下本期一笔支出后，未执行期次的预算仍是新情景的那一份，不会再次漂移
  store.addExpense({ date: '2026-10-23', category: 'meal', amountYuan: 600 });
  assert.equal(store.getState().periods[1].budgetToPool, 4829 * 33);
});

test('计划截止日后情景转为只读，不再重写历史期次', () => {
  useMemoryStorage();
  store.reset();
  for (let index = 1; index <= 5; index += 1) store.executePayday(index, '2027-02-05');
  const history = store.getState().periods.map(item => item.saveToPocket);
  const blocked = store.setScenario('松', '2027-02-06');
  assert.equal(blocked.blocked, 'ended');
  assert.equal(store.getState().config.scenario, '中');
  assert.deepEqual(store.getState().periods.map(item => item.saveToPocket), history);
});

test('未划额批次的补差阈值钉在首笔支出时：改情景不会凭空从余额宝补差', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 50 });
  assert.deepEqual(covers(store.getState()), []);
  assert.equal(store.getState().daySlots['2026-09-24'].plannedBudget, 5519);
  store.setScenario('省', '2026-09-24');
  store.addExpense({ date: '2026-09-24', category: 'snack', amountYuan: 0.5 });
  assert.deepEqual(covers(store.getState()), [], '50.50 仍在当初的 55.19 额度内，不该补差');
  store.addExpense({ date: '2026-09-24', category: 'fun', amountYuan: 6 });
  assert.deepEqual(covers(store.getState()), [131], '只对超出钉住额度的部分补差');
  // 阈值是计划口径，不能被当成真实划入：没点划额依旧不能封账退款
  assert.equal(store.settleDay({ date: '2026-09-24' }).blocked, 'not_allocated');
});

test('迁移永远按流水重算期次：空或陈旧的缓存都不会误导页面', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  const state = store.getState();
  const actualBudget = state.periods[0].budgetToPool;
  const stale = JSON.parse(JSON.stringify({ ...state, config: { ...state.config, dailyBudget: 4829, scenario: '省' }, periods: [] }));
  const migrated = migrate(stale);
  assert.equal(migrated.periods.length, 5);
  assert.equal(migrated.periods[0].budgetToPool, actualBudget, '已执行期次以流水为准');
  assert.equal(migrated.periods[1].budgetToPool, 4829 * 33, '未执行期次用缓存里的情景');
  assert.deepEqual(migrate({ config: { dailyBudget: 5519 }, ledger: { expenses: [], transfers: [] } }).periods, derivePeriods());
});

test('改情景后的当天，提示与额度口径都跟着真实划入走', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.setScenario('省', '2026-09-24');
  const result = store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 50 });
  assert.equal(result.budgetFen, 5519, '额度口径取当天真实划入的 55.19，而不是新的 48.29');
  assert.equal(result.coverFen, 0, '50 元没超支，页面不该报出没发生的补差');
  assert.deepEqual(covers(result.state), []);
  const over = store.addExpense({ date: '2026-09-24', category: 'snack', amountYuan: 8 });
  assert.equal(over.coverFen, 281, '58 元超出 55.19，真实补差 2.81');
  assert.deepEqual(covers(over.state), [281]);
});
