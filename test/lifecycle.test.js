// P1/P2 回归：计划生命周期的只读边界。
// 「截止日之后账本只读」必须覆盖所有会改动历史账务状态的写入口；
// 而分类整理与余额校准入的是另一套口径（回顾期），这里把它钉成文，避免以后再各写一半。
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../miniprogram/store/store');
const { ACCT, accountBalances } = require('../miniprogram/domain/ledger');
const { buildLedgerEvents } = require('../miniprogram/domain/ledger-view');

const D = '2026-09-24';
const LAST = '2027-02-05';   // 截止日当天：仍可写
const AFTER = '2027-02-06';  // 截止日之后：只读

function seed(setup) {
  const map = new Map();
  global.wx = {
    getStorageSync: key => (map.has(key) ? map.get(key) : ''),
    setStorageSync: (key, value) => map.set(key, value),
    removeStorageSync: key => map.delete(key),
    showToast: () => {}
  };
  store.reset();
  if (setup) setup();
  return map;
}

const paydaysOf = state => state.ledger.transfers.filter(item => item.kind === 'payday_income').map(item => item.date);
const balancesOf = state => accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);

test('截止日之后不能补登任何一期发薪日（含第五期）', () => {
  seed();
  [1, 2, 3, 4, 5].forEach(index => {
    const result = store.executePayday(index, AFTER);
    assert.equal(result.blocked, 'ended', `第 ${index} 期必须被计划生命周期挡住`);
    assert.equal(result.persisted, true, '被挡住是业务结论，不是写失败');
  });
  assert.deepEqual(paydaysOf(store.getState()), [], '一笔工资流水都不能凭空出现');
  assert.deepEqual(Object.keys(store.getState().executedPaydays), []);
  assert.deepEqual(Object.keys(store.getState().paydaySteps), []);
  assert.equal(balancesOf(store.getState()).BANK1, 0);
});

test('截止日当天仍可执行第五期发薪日，边界只卡“之后”', () => {
  seed();
  assert.equal(store.executePayday(5, LAST).blocked, undefined);
  assert.deepEqual(paydaysOf(store.getState()), ['2027-01-25']);
  assert.equal(store.getState().executedPaydays[5], true);
});

test('到账日没到仍然先说「未到到账日」，只读检查不抢这条文案', () => {
  seed();
  assert.equal(store.executePayday(1, '2026-09-23').blocked, 'not_reached');
  assert.equal(store.executePayday(3, '2026-09-30').blocked, 'not_reached');
});

test('截止日后结算模式、SOP 勾选、余粮清理、情景一并转为只读', () => {
  seed();
  assert.equal(store.setMode('three-day', AFTER).blocked, 'ended');
  assert.equal(store.getState().mode, 'daily', '模式没被改动');
  assert.equal(store.togglePaydayStep(1, 2, AFTER).blocked, 'ended', '结束后依然只读');
  assert.deepEqual(store.getState().paydaySteps, {});
  assert.equal(store.sweepPoolSurplus({ asOfDate: AFTER }).blocked, 'ended');
  assert.equal(store.setScenario('省', AFTER).blocked, 'ended');
  assert.equal(store.getState().config.dailyBudget, 5519, '额度仍是计划里那一份');
  assert.equal(store.addSpecial({ date: AFTER, reason: '结束后买的', amountYuan: 10 }).blocked, 'ended');
  assert.equal(store.addExpense({ date: AFTER, category: 'meal', amountYuan: 10 }).blocked, 'ended');
  store.addSpecial({ date: LAST, reason: '期末专项', amountYuan: 10 });
  assert.equal(store.reverseSpecial({ id: store.getState().ledger.specials[0].id, asOfDate: AFTER }).blocked, 'ended');
});

test('截止日之前仍可改模式；SOP 勾选一律由流水派生、拒绝手勾', () => {
  seed();
  assert.equal(store.setMode('three-day', D).blocked, undefined, '三日批次只能在首日切', );
  assert.equal(store.getState().mode, 'three-day');
  assert.equal(store.togglePaydayStep(1, 2, D).blocked, 'derived_step');
  assert.equal(store.getState().paydaySteps['1-2'], undefined, '手勾不再落账');
});

test('余额校准是唯一保留的回顾期写入口，并自带 postPlan 标记', () => {
  seed();
  const result = store.addAdjust({ date: AFTER, acct: ACCT.POOL2, realBalanceYuan: 1, bookBalanceYuan: 2, note: '结束后对账' });
  assert.equal(result.persisted, true);
  const adjust = store.getState().ledger.adjusts[0];
  assert.equal(adjust.postPlan, true, '截止日后的校准要单独标成回顾期口径');
  assert.equal(adjust.diff, -100);
  // 计划期间与计划开始前的期初对账都不打这个标记
  store.addAdjust({ date: '2026-09-19', acct: ACCT.BANK1, realBalanceYuan: 10, bookBalanceYuan: 10 });
  store.addAdjust({ date: LAST, acct: ACCT.POCKET3, realBalanceYuan: 10, bookBalanceYuan: 10 });
  const [pre, inPlan] = store.getState().ledger.adjusts.slice(1);
  assert.equal(pre.postPlan, undefined, '期初对账不是回顾期校准');
  assert.equal(inPlan.postPlan, undefined);
  const titles = buildLedgerEvents(store.getState(), { types: ['adjust'] }).map(item => item.title);
  assert.deepEqual(titles, ['回顾期校准', '余额校准', '余额校准'], '按业务日期倒序，回顾期校准单独标注');
});

test('分类整理不改动历史金额，截止日后仍可用', () => {
  seed();
  const created = store.addCategory({ id: 'late', name: '回顾', mark: '回' });
  assert.equal(created.persisted, true);
  assert.equal(store.getState().categories.some(item => item.id === 'late'), true);
  assert.equal(store.removeCategory('late').persisted, true);
  assert.equal(store.getState().categories.some(item => item.id === 'late'), false);
});

test('输入金额与账户统一由领域层把关，非法值不再抛异常', () => {
  seed();
  assert.equal(store.addExpense({ date: D, category: 'meal', amountYuan: 'abc' }).blocked, 'bad_amount');
  assert.equal(store.addExpense({ date: D, category: 'meal', amountYuan: 0 }).blocked, 'bad_amount');
  assert.equal(store.addExpense({ date: D, category: 'meal', amountYuan: '-3' }).blocked, 'bad_amount');
  assert.equal(store.addSpecial({ date: D, reason: '  ', amountYuan: 10 }).blocked, 'bad_reason');
  assert.equal(store.addSpecial({ date: D, reason: '水电', amountYuan: '10.999' }).blocked, undefined, '10.999 元按领域层口径进位');
  assert.equal(store.getState().ledger.specials[0].amount, 1100);
  assert.equal(store.addAdjust({ date: D, acct: 'WALLET', realBalanceYuan: 1, bookBalanceYuan: 1 }).blocked, 'bad_account');
  assert.equal(store.addAdjust({ date: '2026/09/24', acct: ACCT.BANK1, realBalanceYuan: 1, bookBalanceYuan: 1 }).blocked, 'bad_account');
  assert.equal(store.addAdjust({ date: D, acct: ACCT.BANK1, realBalanceYuan: '十块', bookBalanceYuan: 1 }).blocked, 'bad_amount');
  assert.equal(store.getState().ledger.adjusts.length, 0, '非法校准一笔都不落');
  assert.equal(store.getState().ledger.expenses.length, 0);
  assert.equal(store.getState().ledger.specials.length, 1);
});
