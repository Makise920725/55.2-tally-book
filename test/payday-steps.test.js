// 两段到账回归：工资日与生活费日各自登记，步骤完成状态一律由真实流水派生，
// 第六步「清理余粮」必须靠真实 carry_over 转账，手勾不出任何一步。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const store = require('../miniprogram/store/store');
const { ACCT, accountBalances } = require('../miniprogram/domain/ledger');

const D = '2026-09-24';
const ALLOWANCE_DAY = '2026-09-28';
const PERIOD1_END = '2026-10-22';
const AFTER = '2027-02-06';

let toasts = [];
function useWx() {
  const map = new Map();
  toasts = [];
  global.wx = {
    getStorageSync: key => (map.has(key) ? map.get(key) : ''),
    setStorageSync: (key, value) => map.set(key, value),
    removeStorageSync: key => map.delete(key),
    showToast: options => toasts.push(options.title),
    showModal: options => { if (options.success) options.success({ confirm: true }); }
  };
  return map;
}

function mount(relative) {
  let config = null;
  global.Page = options => { config = options; };
  const target = require.resolve(path.join(__dirname, relative));
  delete require.cache[target];
  require(target);
  const page = { data: { ...config.data } };
  Object.keys(config).forEach(key => {
    if (typeof config[key] === 'function') page[key] = config[key].bind(page);
    else if (key !== 'data') page[key] = config[key];
  });
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  return page;
}

function freezeAt(parts, handler) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(...parts); }
    static now() { return new RealDate(...parts).getTime(); }
  }
  global.Date = FakeDate;
  try { handler(); } finally { global.Date = RealDate; }
}

const balancesOf = () => {
  const state = store.getState();
  return accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);
};
const kindsOf = () => store.getState().ledger.transfers.map(item => item.kind);

test('工资日只登记工资：先还账单、再补预算池，不够的部分留给生活费日', () => {
  useWx();
  store.reset();
  const result = store.registerSalaryDay(1, D);
  assert.equal(result.persisted, true);
  const state = store.getState();
  assert.deepEqual(kindsOf(), ['payday_income', 'bill_repay', 'payday_budget']);
  const amounts = Object.fromEntries(state.ledger.transfers.map(item => [item.kind, item.amount]));
  assert.equal(amounts.payday_income, 330000, '第 1 期工资 3,300.00');
  assert.equal(amounts.bill_repay, 184432, '账单优先');
  assert.equal(amounts.payday_budget, 145568, '剩下的全部入池：3,300 − 1,844.32 = 1,455.68，差 144.83 等生活费');
  assert.equal(balancesOf()[ACCT.BANK1], 0, '工资卡归零，不提前留下任何钱');
  assert.equal(store.getState().periods[0].pendingPool, 14483);
  assert.equal(store.getState().periods[0].pendingSave, 185517);
  assert.equal(store.getState().periods[0].fullyFunded, false);
});

test('生活费日登记 2,000：先补足预算池，剩下全部转进小荷包', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  const result = store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: ALLOWANCE_DAY });
  assert.equal(result.persisted, true);
  const state = store.getState();
  assert.deepEqual(kindsOf(), ['payday_income', 'bill_repay', 'payday_budget', 'allowance_income', 'payday_budget', 'payday_save']);
  const second = state.ledger.transfers.slice(3);
  assert.equal(second[0].amount, 200000, '生活费固定 2,000');
  assert.equal(second[0].date, ALLOWANCE_DAY);
  assert.equal(second[1].amount, 14483, '先补足预算池的缺口');
  assert.equal(second[2].amount, 185517, '剩下 1,855.17 全部转存');
  assert.equal(balancesOf()[ACCT.BANK1], 0);
  const period = state.periods[0];
  assert.equal(period.fullyFunded, true);
  assert.equal(period.budgetToPool, 160051, '两笔到齐后期末口径与旧计划表逐分一致');
  assert.equal(period.saveToPocket, 185517);
  assert.equal(period.pocketAfter, 185517);
});

test('第 3 期工资足够：工资日先存 866.01，生活费日再存 2,000', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(3, '2026-11-25');
  assert.equal(store.getState().periods[2].pendingSave, 200000, '未到生活费的转存缺口 = 2,000');
  const salaryFlows = store.getState().ledger.transfers.map(item => `${item.kind}=${item.amount}`);
  assert.deepEqual(salaryFlows, ['payday_income=345000', 'bill_repay=92829', 'payday_budget=165570', 'payday_save=86601']);
  store.registerAllowance(3, { date: '2026-11-28', asOfDate: '2026-11-28' });
  const saveAmounts = store.getState().ledger.transfers.filter(item => item.kind === 'payday_save').map(item => item.amount);
  assert.deepEqual(saveAmounts, [86601, 200000], '两笔转存合计 2,866.01，与计划一致');
  assert.equal(store.getState().periods[2].saveToPocket, 286601);
});

test('前置校验：生活费不能早于工资登记，也没有第二次生活费', () => {
  useWx();
  store.reset();
  assert.equal(store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: ALLOWANCE_DAY }).blocked, 'salary_pending');
  store.registerSalaryDay(1, D);
  assert.equal(store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: ALLOWANCE_DAY }).blocked, undefined);
  assert.equal(store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: ALLOWANCE_DAY }).alreadyReceived, true);
  assert.equal(store.getState().ledger.transfers.filter(item => item.kind === 'allowance_income').length, 1);
  // 工资也不能重复登记
  assert.equal(store.registerSalaryDay(1, D).alreadyReceived, true);
  // 生活费必须落在本期区间内
  store.reset();
  store.registerSalaryDay(1, D);
  assert.equal(store.registerAllowance(1, { date: '2026-10-23', asOfDate: '2026-10-23' }).blocked, 'outside_range');
});

test('工资日之前不能预登记，之后能补登记；截止日后一律只读', () => {
  useWx();
  store.reset();
  assert.equal(store.registerSalaryDay(1, '2026-09-23').blocked, 'not_reached');
  assert.equal(store.registerSalaryDay(5, AFTER).blocked, 'ended');
  assert.equal(store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: AFTER }).blocked, 'ended');
  const state = store.getState();
  assert.deepEqual(state.ledger.transfers, [], '被挡住的登记一笔都不写');
  assert.deepEqual(Object.keys(state.executedPaydays), []);
});

test('步骤完成状态全部由流水派生，手勾一律拒绝', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  let status = store.paydayStepStatus(store.getState(), 1);
  assert.deepEqual(status.done, [true, false, true, false, false, false], '工资到、账单还清、池子没补满');
  store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: ALLOWANCE_DAY });
  status = store.paydayStepStatus(store.getState(), 1);
  assert.deepEqual(status.done, [true, true, true, true, true, false], '两笔到账后前五步全真，只差清理余粮');
  assert.equal(status.transferDone, true);
  assert.equal(status.allDone, false);
  assert.equal(status.fullyFunded, true);
  // 手勾拒绝且不落任何勾
  assert.equal(store.togglePaydayStep(1, 2, D).blocked, 'derived_step');
  assert.deepEqual(store.getState().paydaySteps, {});
  assert.equal(store.togglePaydayStep(1, 6, D).blocked, 'derived_step');
});

test('第六步由本期内的 carry_over 流水派生，跨期不算', () => {
  useWx();
  store.reset();
  store.executePayday(1, D);
  assert.equal(store.isPaydayStepDone(store.getState(), 1, 6), false);
  store.executePayday(5, '2027-01-25');
  const swept = store.sweepPoolSurplus({ asOfDate: '2027-02-05' });
  assert.ok(swept.transfer && swept.transfer.kind === 'carry_over');
  const state = store.getState();
  assert.equal(store.isPaydayStepDone(state, 5, 6), true);
  assert.equal(store.paydayStepStatus(state, 5).allDone, true);
  assert.equal(store.isPaydayStepDone(state, 1, 6), false, '别的期次转的钱不算本期');
  assert.equal(store.periodSweptFen(state, 5), swept.swept);
});

test('旧账本的一笔合并入账按「工资 + 2,000 生活费」识别，历史流水一字不改', () => {
  useWx();
  store.reset();
  // 模拟旧版一次性登记：500 分手续费式的合并入账 5,300
  const legacy = JSON.parse(JSON.stringify(store.getState()));
  legacy.ledger.transfers = [
    { id: 'pay_in_1', date: D, from: ACCT.OUT, to: ACCT.BANK1, amount: 530000, kind: 'payday_income', createdAt: '2026-09-24T01:00:00.000Z' },
    { id: 'bill_1', date: D, from: ACCT.BANK1, to: ACCT.BILL, amount: 184432, kind: 'bill_repay', createdAt: '2026-09-24T01:00:00.000Z' },
    { id: 'budget_1', date: D, from: ACCT.BANK1, to: ACCT.POOL2, amount: 160051, kind: 'payday_budget', createdAt: '2026-09-24T01:00:00.000Z' },
    { id: 'save_1', date: D, from: ACCT.BANK1, to: ACCT.POCKET3, amount: 185517, kind: 'payday_save', createdAt: '2026-09-24T01:00:00.000Z' }
  ];
  legacy.executedPaydays = { 1: true };
  const restored = store.restoreFromBackup(legacy);
  assert.equal(restored.ok, true);
  const period = store.getState().periods[0];
  assert.equal(period.salaryIn, 330000, '按计划工资识别工资部分');
  assert.equal(period.allowanceIn, 200000, '差额识别为生活费');
  assert.equal(period.fullyFunded, true);
  assert.equal(period.saveToPocket, 185517);
  assert.equal(store.getState().ledger.transfers.length, 4, '历史流水不改写');
});

test('发薪日页：两段按钮按到账进度出现，第六步真实转存后才显示全部完成', () => {
  useWx();
  freezeAt([2026, 9, 27, 10, 0, 0], () => {        // 2026-09-27，工资已到、生活费未到
    store.reset();
    store.registerSalaryDay(1, D);
    const page = mount('../miniprogram/pages/payday/index.js');
    page.onLoad();
    page.setData({ periodIndex: 1 });
    page.refresh();
    assert.deepEqual(page.data.steps.map(item => item.done), [true, false, true, false, false, false]);
    assert.equal(page.data.period.salaryReceived, true);
    assert.equal(page.data.period.allowanceReceived, false);
    assert.equal(page.data.canRegisterAllowance, true, '工资已登记后可以登记生活费');
    assert.match(page.data.statusText, /等生活费到账/);
    assert.match(page.data.steps[3].flowText, /生活费到账后补 ¥144\.83/);
    assert.match(page.data.steps[4].flowText, /生活费到账后存 ¥1855\.17/);

    // 登记生活费：前五步全部点亮
    page.registerAllowance({ detail: { value: '2026-09-28' } });
    page.refresh();
    assert.deepEqual(page.data.steps.map(item => item.done), [true, true, true, true, true, false]);
    assert.equal(page.data.transferDone, true);
    assert.equal(page.data.allDone, false, '没清余粮就不算全部完成');

    // 真实转存一次余粮：第六步点亮
    page.setData({ periodIndex: 1 });
    const swept = store.sweepPoolSurplus({ asOfDate: '2026-09-29' });
    assert.ok(swept.swept > 0, '工资日与生活费日之间确实有余粮可清');
    page.refresh();
    assert.equal(page.data.steps[5].done, true);
    assert.match(page.data.steps[5].flowText, new RegExp(`本期已转存小荷包 ¥${(swept.swept / 100).toFixed(2)}`));
    assert.equal(page.data.allDone, true);
    page.onUnload();
  });
});

test('发薪日页：工资未登记时先只给工资按钮，且不能登记生活费', () => {
  useWx();
  freezeAt([2026, 9, 25, 10, 0, 0], () => {
    store.reset();
    const page = mount('../miniprogram/pages/payday/index.js');
    page.onLoad();
    page.setData({ periodIndex: 1 });
    page.refresh();
    assert.equal(page.data.canRegisterSalary, true);
    assert.equal(page.data.canRegisterAllowance, false);
    assert.match(page.data.statusText, /工资还没登记/);
    page.registerSalary();
    page.refresh();
    assert.equal(page.data.period.salaryReceived, true);
    page.onUnload();
  });
});

test('发薪日页：截止日之后按钮全部禁用，不再登记流水', () => {
  useWx();
  freezeAt([2027, 1, 6, 10, 0, 0], () => {          // 2027-02-06
    store.reset();
    const page = mount('../miniprogram/pages/payday/index.js');
    page.onLoad();
    page.setData({ periodIndex: 5 });
    page.refresh();
    assert.equal(page.data.canRegisterSalary, false);
    assert.equal(page.data.canRegisterAllowance, false);
    page.registerSalary();
    assert.ok(toasts.some(title => title.includes('只读')), '要告诉用户账本已只读');
    assert.equal(store.getState().ledger.transfers.filter(item => item.kind === 'payday_income').length, 0);
    page.onUnload();
  });
});

test('只登记工资的期次不算锁定：切情景时它的未安置部分按新情景重算', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  const before = store.getState().periods[0];
  const switched = store.setScenario('省', D);
  assert.deepEqual(switched.frozen, [], '只登记工资不算锁定');
  assert.deepEqual(switched.replanned, [1, 2, 3, 4, 5]);
  const after = store.getState().periods[0];
  assert.equal(after.billPlaced, before.billPlaced, '账单已经真实还掉，不受情景影响');
  assert.equal(after.poolPlaced, before.poolPlaced, '已经进余额宝的钱不会因切情景被搬走');
  assert.equal(after.planBudget, 4829 * 29, '未安置的目标按新情景重算');
  assert.equal(after.planSave, 530000 - 184432 - 4829 * 29);
  assert.equal(after.pendingPool, 0, '池子里已经比新目标多，不用再补');
  // 池子里比新目标多出来的 55.27 就是「余粮」，由第六步真实转入小荷包，不会凭空蒸发。
  const surplus = store.previewPoolSurplus(D);
  assert.equal(surplus.surplus, before.poolPlaced - 4829 * 29);
  // 生活费到账后：不再入池（已超额），2,000 全部转进小荷包
  store.registerAllowance(1, { date: '2026-09-28', asOfDate: '2026-09-28' });
  const done = store.getState().periods[0];
  assert.equal(done.poolPlaced, before.poolPlaced, '余额宝金额保持真实，不被追改');
  assert.equal(done.savePlaced, 200000, '2,000 全部进储蓄');
  assert.equal(done.fullyFunded, true);
  // 真实清理余粮：余额宝回到「剩余天数 × 省情景额度」，多出的钱进小荷包
  const swept = store.sweepPoolSurplus({ asOfDate: D });
  assert.equal(swept.swept, surplus.surplus);
  assert.equal(balancesOf()[ACCT.POOL2], 4829 * 29, '清理后余额宝只剩剩余天数的计划开销');
});

test('两笔到齐的期次在切情景时保持流水金额不变', () => {
  useWx();
  store.reset();
  store.executePayday(1, D);
  const before = store.getState().periods[0];
  const switched = store.setScenario('省', '2026-10-23');
  assert.deepEqual(switched.frozen, [1]);
  const after = store.getState().periods[0];
  assert.equal(after.budgetToPool, before.budgetToPool);
  assert.equal(after.saveToPocket, before.saveToPocket);
  assert.equal(after.poolPlaced, before.poolPlaced);
});

test('旧版本合并登记的期次带旧口径标记，金额一分不改', () => {
  useWx();
  store.reset();
  const legacy = JSON.parse(JSON.stringify(store.getState()));
  legacy.ledger.transfers = [
    { id: 'pay_in_1', date: D, from: ACCT.OUT, to: ACCT.BANK1, amount: 530000, kind: 'payday_income', createdAt: '2026-09-24T01:00:00.000Z' },
    { id: 'bill_1', date: D, from: ACCT.BANK1, to: ACCT.BILL, amount: 184432, kind: 'bill_repay', createdAt: '2026-09-24T01:00:00.000Z' },
    { id: 'budget_1', date: D, from: ACCT.BANK1, to: ACCT.POOL2, amount: 160051, kind: 'payday_budget', createdAt: '2026-09-24T01:00:00.000Z' },
    { id: 'save_1', date: D, from: ACCT.BANK1, to: ACCT.POCKET3, amount: 185517, kind: 'payday_save', createdAt: '2026-09-24T01:00:00.000Z' }
  ];
  assert.equal(store.restoreFromBackup(legacy).ok, true);
  const period = store.getState().periods[0];
  assert.equal(period.legacyMerged, true);
  assert.equal(period.allowanceDate, D, '旧口径识别为同日到账');
  assert.equal(period.saveToPocket, 185517);
});
