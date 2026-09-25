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

// ---- 2026-09-24 code review 修复：两段到账的几处回归钉子 ----

test('第六步：工资日就能清出上一期的真实余粮，不被预算池缺口吞掉', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: ALLOWANCE_DAY });
  // 第 1 期 29 天每天只花 ¥50（额度 ¥55.19）：期末余额宝里留下 29 × 5.19 = ¥150.51 的真余粮
  for (let at = Date.UTC(2026, 8, 24); at <= Date.UTC(2026, 9, 22); at += 86400000) {
    const date = new Date(at).toISOString().slice(0, 10);
    store.allocateDay({ date });
    store.addExpense({ date, category: 'meal', amountYuan: '50.00' });
    store.settleDay({ date, asOfDate: date });
  }
  const leftover = balancesOf()[ACCT.POOL2];
  assert.equal(leftover, 29 * 519, '第 1 期少花的钱留在余额宝里');

  // 第 2 期工资日：池子还差 ¥647.88 才满，但这笔钱生活费到账时一定会补进来，
  // 所以它不该占「现在必须留在池子里」的名额 —— 上一期的 ¥150.51 当天就要能清出来。
  store.registerSalaryDay(2, '2026-10-23');
  const preview = store.previewPoolSurplus('2026-10-23');
  assert.equal(preview.pendingPool, 64788);
  assert.equal(preview.remainingNeed, 33 * 5519);
  assert.equal(preview.reserve, 33 * 5519 - 64788, '现在只需留「本期开销 − 生活费还会补的部分」');
  assert.equal(preview.surplus, leftover, '修复前这里是 0：缺口把真实余粮整个吞掉');
  const swept = store.sweepPoolSurplus({ asOfDate: '2026-10-23' });
  assert.equal(swept.swept, leftover);
  assert.equal(balancesOf()[ACCT.POOL2], 33 * 5519 - 64788);
  assert.equal(store.paydayStepStatus(store.getState(), 2).done[5], true, '第六步当天就点亮，不用拖到生活费日');
  // 生活费到账：只补缺口，不会把已经清走的余粮再算一次
  assert.deepEqual(store.registerAllowance(2, { date: '2026-10-27', asOfDate: '2026-10-27' }).placements,
    { bill: 0, pool: 64788, save: 135212 });
  assert.equal(balancesOf()[ACCT.POOL2], 33 * 5519, '两笔到齐后池子正好是本期计划开销');
  assert.equal(Object.values(balancesOf()).reduce((total, value) => total + value, 0), 0, '复式记账守恒');
});

test('储蓄页「本期实际转存」念真实流水，中间态不再显示计划值', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(3, '2026-11-25');
  const page = mount('../miniprogram/pages/pocket/index.js');
  page.onLoad();
  const row = page.data.periods[2];
  assert.equal(row.save, '866.01', '真实只写了 ¥866.01（修复前这里显示计划值 ¥2866.01）');
  assert.equal(row.planSaveText, '2866.01', '计划值单独一列，两套口径分开摆');
  assert.equal(row.actualAfter, '866.01', '与同一张卡的「已执行累计」一致');
  assert.equal(row.statusText, '待生活费 ¥2000.00');
  assert.equal(row.completed, false);
  store.registerAllowance(3, { date: '2026-11-28', asOfDate: '2026-11-28' });
  page.refresh();
  assert.equal(page.data.periods[2].save, '2866.01');
  assert.equal(page.data.periods[2].actualAfter, '2866.01');
  assert.equal(page.data.periods[2].completed, true);
  page.onUnload();
});

test('今日页跨期提醒漏登的生活费：不能只看今天所属的那一期', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  store.registerSalaryDay(2, '2026-10-23');
  freezeAt([2026, 9, 27, 9, 0, 0], () => {                 // 2026-10-27，人已经在第 2 期
    const page = mount('../miniprogram/pages/today/index.js');
    page.onLoad();
    assert.match(page.data.allowanceNotice, /第 1 期生活费还没登记/, '修复前这里是空字符串，¥2,000 静默漏掉');
    assert.match(page.data.allowanceNotice, /2026-09-28/);
    page.onUnload();
  });
  freezeAt([2026, 9, 25, 9, 0, 0], () => {                 // 2026-10-25：本期区间已过，要给出补登路径
    const page = mount('../miniprogram/pages/today/index.js');
    page.onLoad();
    assert.match(page.data.allowanceNotice, /本期区间已在 2026-10-22 结束/);
    assert.match(page.data.allowanceNotice, /实际到账日/);
    page.onUnload();
  });
});

test('生活费逾期：发薪日页主按钮按本期最后一天补登，不再是 outside_range 死路', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  let content = null;
  freezeAt([2026, 9, 25, 9, 0, 0], () => {                 // 2026-10-25 > 本期结束 2026-10-22
    const page = mount('../miniprogram/pages/payday/index.js');
    page.onLoad();
    page.setData({ periodIndex: 1 });
    page.refresh();
    assert.equal(page.data.allowanceOverdue, true);
    assert.equal(page.data.allowancePickerValue, PERIOD1_END, '默认到账日夹到本期最后一天');
    assert.equal(page.data.allowancePickerEnd, PERIOD1_END);
    assert.equal(page.data.canRegisterAllowance, true);
    assert.equal(page.data.allowanceButtonText, '补登生活费到账 ¥2000.00');
    assert.match(page.data.period.overdueNote, /2026-10-22/);
    const realShowModal = global.wx.showModal;
    global.wx.showModal = options => { content = options.content; options.success({ confirm: true }); };
    page.registerAllowance({ detail: { x: 12, y: 34 } });   // tap 事件的 detail 是坐标，取不到 value
    global.wx.showModal = realShowModal;
    page.onUnload();
  });
  assert.match(content, /已于 2026-10-22 到账/, '确认弹窗必须把补登日期念出来');
  const flow = store.getState().ledger.transfers.find(item => item.kind === 'allowance_income');
  assert.equal(flow.date, PERIOD1_END, '修复前点按钮只会被挡成 outside_range，用户找不到补登入口');
  assert.equal(flow.periodIndex, 1);
  assert.equal(store.getState().periods[0].fullyFunded, true);
});

test('executePayday 报告写盘失败时，不会留下半截流水', () => {
  // 要钉住的是这条性质：**只要返回 persisted:false，账本里就不能有半截流水**。
  // 早先的实现是「先提交工资、再提交生活费」，第二次写盘失败时工资那 3 笔已经落盘，
  // 页面却弹「本次改动没有保存」——所以要让每一次写盘都轮流失败一遍。
  for (const failOn of [1, 2, 3]) {
    useWx();
    store.reset();
    let calls = 0;
    const realSet = global.wx.setStorageSync;
    global.wx.setStorageSync = (key, value) => { calls += 1; if (calls === failOn) throw new Error('disk full'); return realSet(key, value); };
    const result = store.executePayday(1, D);
    global.wx.setStorageSync = realSet;
    const transfers = store.getState().ledger.transfers;
    if (result.persisted === false) {
      assert.deepEqual(transfers, [], `第 ${failOn} 次写盘失败：不能留下半截流水（工资落盘、生活费没落）`);
      assert.equal(store.getState().periods[0].salaryReceived, false);
    } else {
      assert.equal(transfers.length, 6, '要么两段一起落地，要么一笔都不落');
      assert.equal(store.getState().periods[0].fullyFunded, true);
    }
  }
  // 同日到账的两段现在只有一次 commit：这是上面那条性质成立的结构性原因。
  useWx();
  store.reset();
  let writes = 0;
  const realSet = global.wx.setStorageSync;
  global.wx.setStorageSync = (key, value) => { writes += 1; return realSet(key, value); };
  store.executePayday(1, D);
  global.wx.setStorageSync = realSet;
  assert.equal(writes, 1, '工资 + 生活费 6 笔流水一次落盘');
  assert.deepEqual(kindsOf(), ['payday_income', 'bill_repay', 'payday_budget', 'allowance_income', 'payday_budget', 'payday_save']);
});

test('打勾与文案同一个分母：切过情景也不会「打了勾却说还差」', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  store.setScenario('省', '2026-09-25');
  store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: ALLOWANCE_DAY });
  freezeAt([2026, 8, 28, 12, 0, 0], () => {
    const page = mount('../miniprogram/pages/payday/index.js');
    page.onLoad();
    page.setData({ periodIndex: 1 });
    page.refresh();
    assert.deepEqual(page.data.steps.map(item => item.done), [true, true, true, true, true, false]);
    page.data.steps.forEach(item => {
      if (item.done) assert.ok(!/还差/.test(item.flowText), `第 ${item.index} 步打了勾却写着还差：${item.flowText}`);
    });
    assert.match(page.data.steps[3].flowText, /已补满 \/ ¥1455\.68 · 本期计划 ¥1400\.41/, '目标与计划不同时把计划值写出来');
    assert.match(page.data.steps[4].flowText, /已存够 \/ ¥2000\.00 · 本期计划 ¥2055\.27/);
    assert.equal(page.data.period.pendingSave, 0);
    page.onUnload();
  });
});

test('生活费到账日必须是真实存在的日子；期次越界返回 blocked 而不是抛异常', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  assert.equal(store.registerAllowance(1, { date: '2026-09-31', asOfDate: '2026-10-01' }).blocked, 'bad_date',
    '9 月没有 31 日：光看 YYYY-MM-DD 格式挡不住，假日期会被 resolveBatchRange 当成真实批次');
  assert.equal(store.registerAllowance(1, { date: '2026-2-3', asOfDate: '2026-10-01' }).blocked, 'bad_date');
  assert.equal(store.registerAllowance(1, { date: '', asOfDate: '2026-10-01' }).blocked, 'bad_date');
  assert.equal(store.getState().ledger.transfers.filter(item => item.kind === 'allowance_income').length, 0);
  for (const bad of [0, 6, -1, null, 'abc', '1.5']) {
    assert.equal(store.registerSalaryDay(bad, D).blocked, 'bad_period', `registerSalaryDay(${String(bad)})`);
    assert.equal(store.registerAllowance(bad, { date: D, asOfDate: D }).blocked, 'bad_period', `registerAllowance(${String(bad)})`);
  }
  assert.equal(store.executePayday(0, D).blocked, 'bad_period');
});

// ---- 自选安置：这笔到账放账单 / 余额宝 / 小荷包各多少，由用户决定 ----

test('自选安置：三项合计必须正好等于到账额，账单不能超额，非法金额一律拒', () => {
  useWx();
  store.reset();
  // 与推荐值相同的自选分配：照样接受
  assert.deepEqual(store.registerSalaryDay(1, D, { split: { billYuan: '1844.32', poolYuan: '1455.68', saveYuan: '0' } }).placements,
    { bill: 184432, pool: 145568, save: 0 });
  store.reset();
  assert.equal(store.registerSalaryDay(1, D, { split: { billYuan: '1844.32', poolYuan: '100', saveYuan: '0' } }).blocked, 'split_mismatch', '合计少了');
  assert.equal(store.registerSalaryDay(1, D, { split: { billYuan: '1844.32', poolYuan: '1455.68', saveYuan: '1' } }).blocked, 'split_mismatch', '合计多了');
  assert.equal(store.registerSalaryDay(1, D, { split: { billYuan: '3300', poolYuan: '0', saveYuan: '0' } }).blocked, 'bill_over', '合计对得上但账单超额');
  assert.equal(store.registerSalaryDay(1, D, { split: { billYuan: '-10', poolYuan: '3310', saveYuan: '0' } }).blocked, 'bad_split', '负数');
  assert.equal(store.registerSalaryDay(1, D, { split: { billYuan: 'abc', poolYuan: '0', saveYuan: '0' } }).blocked, 'bad_split', '非数字');
  assert.deepEqual(store.getState().ledger.transfers, [], '被拒的分配一笔都不写');
  // 生活费的 split 走同一套校验；它排在 salary_pending 之后，所以要先登记工资才测得到
  store.registerSalaryDay(1, D);
  assert.equal(store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: ALLOWANCE_DAY, split: { billYuan: '0', poolYuan: '100' } }).blocked, 'split_mismatch');
  assert.equal(store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: ALLOWANCE_DAY, split: { billYuan: '10', poolYuan: '1990', saveYuan: '0' } }).blocked, 'bill_over', '账单已还清，不能再往里塞');
  assert.equal(store.getState().ledger.transfers.filter(item => item.kind === 'allowance_income').length, 0, '被拒的生活费分配一笔都不写');
  // 不给 split = 用推荐值：旧调用方（executePayday、浸泡测试）一律不受影响
  store.reset();
  assert.deepEqual(store.registerSalaryDay(1, D).placements, { bill: 184432, pool: 145568, save: 0 });
  assert.equal(store.executePayday(2, '2026-10-23').placements.save, 135212, '兼容入口仍走推荐安置');
});

test('自选安置：少还账单第三步就不点亮，生活费的推荐值会先把账单补齐', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D, { split: { billYuan: '1344.32', poolYuan: '0', saveYuan: '1955.68' } });
  let period = store.getState().periods[0];
  assert.equal(period.pendingBill, 50000, '还欠 ¥500');
  assert.equal(period.billTotal, period.planBill, '账单是外部固定义务，不因为少还就跟着缩水');
  assert.deepEqual(store.paydayStepStatus(store.getState(), 1).done, [true, false, false, false, true, false],
    '账单没还清，第三步不能打勾');
  assert.equal(period.allowancePlan.bill, 50000, '生活费的推荐值优先把账单补齐');
  assert.equal(period.allowancePlan.pool, 150000);
  store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: ALLOWANCE_DAY });
  period = store.getState().periods[0];
  assert.equal(period.billPlaced, period.planBill, '两笔到齐后账单刚好还清');
  assert.equal(period.pendingBill, 0);
  assert.deepEqual(store.paydayStepStatus(store.getState(), 1).done.slice(0, 5), [true, true, true, true, true]);
  assert.equal(period.billPlaced + period.poolPlaced + period.savePlaced, period.salaryIn + period.allowanceIn, '已安置 == 已到账');
  assert.equal(balancesOf().BANK1, 0, '工资卡不留下没安置的钱');
  assert.equal(Object.values(balancesOf()).reduce((total, value) => total + value, 0), 0, '复式记账守恒');
});

test('自选安置：多放进余额宝的部分成为余粮，可由第六步真实清进小荷包', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: ALLOWANCE_DAY, split: { billYuan: '0', poolYuan: '2000', saveYuan: '0' } });
  const period = store.getState().periods[0];
  assert.equal(period.poolPlaced, 145568 + 200000, '池子被塞了 3,455.68，计划只要 1,600.51');
  assert.equal(period.savePlaced, 0);
  assert.equal(period.pendingPool, 0, '两笔到齐后目标 = 流水事实');
  const preview = store.previewPoolSurplus('2026-09-29');
  assert.ok(preview.surplus > 180000, '多塞进池子的钱要能被清出来');
  const swept = store.sweepPoolSurplus({ asOfDate: '2026-09-29' });
  assert.equal(swept.swept, preview.surplus);
  assert.equal(balancesOf()[ACCT.POOL2], preview.reserve, '清完池子只剩本期还要花的钱');
  assert.equal(Object.values(balancesOf()).reduce((total, value) => total + value, 0), 0);
});

test('发薪日页：分配草稿当场校验合计，refresh 不冲掉用户输入，一键可回推荐值', () => {
  useWx();
  store.reset();
  freezeAt([2026, 8, 24, 10, 0, 0], () => {
    const page = mount('../miniprogram/pages/payday/index.js');
    page.onLoad();
    page.setData({ periodIndex: 1 });
    page.refresh();
    let editor = page.data.splitEditor;
    assert.equal(editor.title, '这笔工资怎么安置');
    assert.deepEqual([editor.billYuan, editor.poolYuan, editor.saveYuan], ['1844.32', '1455.68', '0.00'], '预填推荐值');
    assert.equal(editor.canSubmit, true);
    assert.equal(editor.billRoomText, '1844.32');
    // 改一项 → 合计立刻不对，按钮禁用并说清差多少
    page.inputSplit({ currentTarget: { dataset: { field: 'poolYuan' } }, detail: { value: '100' } });
    editor = page.data.splitEditor;
    assert.equal(editor.canSubmit, false);
    assert.match(editor.problem, /还差 ¥1355\.68 没安置/);
    // store 每次提交都会触发 refresh：用户正在填的数字不能被冲掉
    page.refresh();
    assert.equal(page.data.splitEditor.poolYuan, '100', '草稿要留住');
    // 一键回推荐值
    page.resetSplit();
    assert.deepEqual([page.data.splitEditor.billYuan, page.data.splitEditor.poolYuan, page.data.splitEditor.saveYuan], ['1844.32', '1455.68', '0.00']);
    // 少放余额宝要给后果提醒：每天的划额都从池子里出
    page.inputSplit({ currentTarget: { dataset: { field: 'poolYuan' } }, detail: { value: '0' } });
    page.inputSplit({ currentTarget: { dataset: { field: 'saveYuan' } }, detail: { value: '1455.68' } });
    assert.match(page.data.splitEditor.notes, /少放 ¥1600\.51 进余额宝/, '工资还没入池，缺口是整个计划池额');
    assert.equal(page.data.splitEditor.canSubmit, true);
    // 少还账单也要提前说清第三步不会点亮
    page.resetSplit();
    page.inputSplit({ currentTarget: { dataset: { field: 'billYuan' } }, detail: { value: '1000' } });
    page.inputSplit({ currentTarget: { dataset: { field: 'saveYuan' } }, detail: { value: '2300' } });
    assert.match(page.data.splitEditor.notes, /第三步「偿还账单」会一直不点亮/);
    // 账单超额：合计对了也不给提交
    page.inputSplit({ currentTarget: { dataset: { field: 'billYuan' } }, detail: { value: '3300' } });
    page.inputSplit({ currentTarget: { dataset: { field: 'saveYuan' } }, detail: { value: '0' } });
    assert.equal(page.data.splitEditor.canSubmit, false);
    assert.match(page.data.splitEditor.problem, /还账单最多 ¥1844\.32/);
    page.onUnload();
  });
});

test('发薪日页：登记完工资，草稿自动切到生活费那一笔并预填推荐值', () => {
  useWx();
  store.reset();
  freezeAt([2026, 8, 24, 10, 0, 0], () => {
    const page = mount('../miniprogram/pages/payday/index.js');
    page.onLoad();
    page.setData({ periodIndex: 1 });
    page.refresh();
    assert.equal(page.data.splitEditor.phase, 'salary');
    store.registerSalaryDay(1, D);          // 触发订阅 → refresh
    const editor = page.data.splitEditor;
    assert.equal(editor.phase, 'allowance', '登记完工资就换成编辑生活费这笔');
    assert.equal(editor.title, '这笔生活费怎么安置');
    assert.equal(editor.incomeText, '2000.00');
    assert.deepEqual([editor.billYuan, editor.poolYuan, editor.saveYuan], ['0.00', '144.83', '1855.17'], '预填生活费的推荐分配');
    assert.equal(editor.billRoomText, '0.00', '账单已还清，不能再往里塞');
    page.onUnload();
  });
});

// ---- 回退已登记的到账：昨天手滑按错了要能原样退回去 ----

test('回退到账：整组删（收入 + 安置），撤销后账本与登记前逐字节一致', () => {
  useWx();
  store.reset();
  const before = JSON.stringify(store.getState().ledger.transfers);
  store.registerSalaryDay(1, D);
  const group = store.getState().ledger.transfers;
  assert.equal(group.length, 3);
  assert.deepEqual(group.filter(item => item.arrivalId).map(item => item.arrivalId), ['pay_in_1', 'pay_in_1'],
    '每一笔安置都记下自己属于哪一笔到账，才能整组精确摘除');
  const preview = store.previewArrivalUndo(1, D);
  assert.equal(preview.canUndo, true);
  assert.equal(preview.kind, 'payday_income');
  assert.deepEqual(preview.placements.map(item => item.kind), ['bill_repay', 'payday_budget']);
  const result = store.undoArrival(1, D);
  assert.equal(result.removed, 3);
  assert.equal(result.removedFen, 330000);
  assert.equal(JSON.stringify(store.getState().ledger.transfers), before, '撤销后与登记前逐字节一致');
  assert.deepEqual(store.getState().executedPaydays, {}, 'executedPaydays 也要清掉');
  assert.equal(store.getState().periods[0].salaryReceived, false);
  assert.equal(Object.values(balancesOf()).reduce((total, value) => total + value, 0), 0);
  assert.equal(store.previewArrivalUndo(1, D).blocked, 'nothing_to_undo', '撤完就没有可撤的了');
});

test('回退到账：两笔都登记了就先撤生活费、再撤工资，顺序反了余额宝会双倍', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  store.registerAllowance(1, { date: ALLOWANCE_DAY, asOfDate: ALLOWANCE_DAY });
  assert.equal(store.previewArrivalUndo(1, ALLOWANCE_DAY).kind, 'allowance_income', '先撤最后一笔');
  store.undoArrival(1, ALLOWANCE_DAY);
  let period = store.getState().periods[0];
  assert.equal(period.allowanceReceived, false);
  assert.equal(period.salaryReceived, true, '工资那笔还在');
  assert.equal(period.poolPlaced, 145568);
  assert.equal(store.previewArrivalUndo(1, ALLOWANCE_DAY).kind, 'payday_income');
  store.undoArrival(1, ALLOWANCE_DAY);
  assert.deepEqual(store.getState().ledger.transfers, [], '两笔都撤掉，账本空');
  period = store.getState().periods[0];
  assert.equal(period.poolPlaced + period.billPlaced + period.savePlaced, 0);
  assert.equal(Object.values(balancesOf()).reduce((total, value) => total + value, 0), 0);
});

test('回退到账：已经划额/封账/花掉/清理过照样能退，但要如实列出后果', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  store.allocateDay({ date: D });
  store.addExpense({ date: D, category: 'meal', amountYuan: '30.00' });
  store.settleDay({ date: D });
  const preview = store.previewArrivalUndo(1, '2026-09-25');
  assert.equal(preview.canUndo, true, '这些后果都不影响记账正确性，不该当成硬阻断');
  assert.deepEqual(preview.warnings, ['allocated', 'sealed', 'spent'], '一次报全，用户不用试三次');
  store.undoArrival(1, '2026-09-25');
  const state = store.getState();
  assert.deepEqual(state.ledger.transfers.map(item => item.kind), ['daily_alloc', 'daily_refund'], '只摘掉这一组，别人的记录不动');
  assert.equal(state.periods[0].salaryReceived, false);
  assert.equal(Object.values(balancesOf()).reduce((total, value) => total + value, 0), 0, '复式账不会被撤销破坏');
  assert.ok(balancesOf()[ACCT.POOL2] < 0, '余额宝显示负数 = 已经花掉的钱还在，如实反映');
  // 重新登记就补齐
  store.registerSalaryDay(1, D);
  assert.equal(Object.values(balancesOf()).reduce((total, value) => total + value, 0), 0);
});

test('回退到账：旧版合并入账与计划结束后是硬阻断，且一笔都不写', () => {
  useWx();
  store.reset();
  const legacy = JSON.parse(JSON.stringify(store.getState()));
  legacy.ledger.transfers = [
    { id: 'pay_in_1', date: D, from: ACCT.OUT, to: ACCT.BANK1, amount: 530000, kind: 'payday_income', periodIndex: 1 },
    { id: 'bill_1', date: D, from: ACCT.BANK1, to: ACCT.BILL, amount: 184432, kind: 'bill_repay', periodIndex: 1 },
    { id: 'budget_1', date: D, from: ACCT.BANK1, to: ACCT.POOL2, amount: 160051, kind: 'payday_budget', periodIndex: 1 },
    { id: 'save_1', date: D, from: ACCT.BANK1, to: ACCT.POCKET3, amount: 185517, kind: 'payday_save', periodIndex: 1 }
  ];
  legacy.executedPaydays = { 1: true };
  assert.equal(store.restoreFromBackup(legacy).ok, true);
  assert.equal(store.previewArrivalUndo(1, D).blocked, 'legacy_merged', '合并入账的期次根本没有独立的到账组');
  assert.equal(store.undoArrival(1, D).blocked, 'legacy_merged');
  assert.equal(store.getState().ledger.transfers.length, 4, '硬阻断时一笔都不写');
  // 关键：**昨天按的**流水没有 arrivalId（这个字段是后加的），必须照样能整组认出来退掉。
  // 早先这里把「缺 arrivalId」一律当成 legacy_group 拒掉，等于这个功能只对修复之后登记的流水有效，
  // 而用户要退的恰恰是修复之前按下的那些 —— 这是真实踩过的坑。
  useWx();
  store.reset();                             // store 是模块级单例：换存储不够，账本得真的清掉
  store.registerSalaryDay(2, '2026-10-23');  // 第 2 期；这次按新版方式正常登记
  const tampered = JSON.parse(JSON.stringify(store.getState()));
  assert.equal(tampered.ledger.transfers.length, 3, '先确认拿到的是第 2 期这批');
  tampered.ledger.transfers.forEach(item => { delete item.arrivalId; });   // 退化成昨天那批流水的样子
  assert.equal(store.restoreFromBackup(tampered).ok, true);
  const legacyPreview = store.previewArrivalUndo(2, '2026-10-23');
  assert.equal(legacyPreview.canUndo, true, '旧流水要按事实认回来，不能因为缺标记就拒');
  assert.deepEqual(legacyPreview.placements.map(item => item.kind), ['bill_repay', 'payday_budget']);
  assert.equal(store.undoArrival(2, '2026-10-23').removed, 3);
  assert.deepEqual(store.getState().ledger.transfers, [], '整组删干净');
  assert.equal(Object.values(balancesOf()).reduce((total, value) => total + value, 0), 0);

  // 计划结束后同样只读
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  assert.equal(store.previewArrivalUndo(1, '2027-02-06').blocked, 'ended');
  assert.equal(store.undoArrival(1, '2027-02-06').blocked, 'ended');
  assert.equal(store.getState().ledger.transfers.length, 3, '结束后一笔都不写');
});

test('回退到账：撤销后备份两层校验仍然放行', () => {
  useWx();
  store.reset();
  const backup = require('../miniprogram/utils/backup');
  store.registerSalaryDay(1, D);
  store.undoArrival(1, D);
  assert.equal(backup.parseBackupText(backup.createBackupText(store.getState(), new Date())).ok, true);
  store.registerSalaryDay(1, D);
  assert.equal(backup.parseBackupText(backup.createBackupText(store.getState(), new Date())).ok, true,
    '撤销后重新登记也要能导出备份');
});

test('发薪日页：回退按钮的显隐、确认弹窗内容与后果提示', () => {
  useWx();
  store.reset();
  freezeAt([2026, 9, 25, 10, 0, 0], () => {
    const page = mount('../miniprogram/pages/payday/index.js');
    page.onLoad();
    page.setData({ periodIndex: 1 });
    page.refresh();
    assert.equal(page.data.undo, null, '什么都没登记时没有回退按钮');
    assert.match(page.data.undoText, /没有已经登记/);
    // 昨天按了工资，今天已经划额 + 封账
    store.registerSalaryDay(1, D);
    store.allocateDay({ date: D });
    store.settleDay({ date: D });
    page.refresh();
    assert.ok(page.data.undo, '已经划额封账也要能给回退入口');
    assert.match(page.data.undoText, /回退这笔到账（工资 ¥3300\.00/);
    let content = null;
    const realShowModal = global.wx.showModal;
    global.wx.showModal = options => { content = options.content; options.success({ confirm: true }); };
    page.undoArrival();
    global.wx.showModal = realShowModal;
    assert.match(content, /会删掉 2026-09-24 这笔 ¥3300\.00 的到账/);
    assert.match(content, /还账单 ¥1844\.32/);
    assert.match(content, /放余额宝 ¥1455\.68/);
    assert.match(content, /余额宝会显示成负数/);
    assert.equal(store.getState().periods[0].salaryReceived, false);
    page.refresh();
    assert.equal(page.data.undo, null, '撤完按钮就消失');
    page.onUnload();
  });
});

test('发薪日页：回退区块紧跟步骤列表，点已完成的步骤不再只说「不用手勾」', () => {
  // 用户反馈过：「昨天已经点过了怎么回退」——那六步的勾是登记到账时按真实流水打上的，
  // 想取消就得让他在勾旁边找得到入口。早先按钮排在整个卡片最下面，被分配编辑器顶下去看不见了。
  useWx();
  store.reset();
  freezeAt([2026, 8, 26, 10, 0, 0], () => {
    const page = mount('../miniprogram/pages/payday/index.js');
    page.onLoad();
    page.setData({ periodIndex: 1 });
    store.registerSalaryDay(1, D);           // 工资到账 ✓、偿还账单 ✓
    page.refresh();
    assert.deepEqual(page.data.steps.map(item => item.done), [true, false, true, false, false, false]);
    assert.ok(page.data.undo, '这几步能被打上，就得能在这里整笔退掉');
    assert.match(page.data.undoText, /回退这笔到账（工资 ¥3300\.00/);

    // 点步骤行要给出可操作的指引，而不是干巴巴一句「不用手勾」
    const toasts = [];
    const realShowToast = global.wx.showToast;
    global.wx.showToast = options => toasts.push(options.title);
    page.toggleStep({ currentTarget: { dataset: { step: 1 } } });
    assert.match(toasts[0], /回退这笔到账/, '第 1/2 步：直接指向回退按钮');
    page.toggleStep({ currentTarget: { dataset: { step: 3 } } });
    assert.match(toasts[1], /安置划转派生/, '第 3/4/5 步：解释它们由分配时决定');
    page.toggleStep({ currentTarget: { dataset: { step: 6 } } });
    assert.match(toasts[2], /清理余粮/, '第 6 步：指向清理按钮');
    global.wx.showToast = realShowToast;
    assert.deepEqual(page.data.steps.map(item => item.done), [true, false, true, false, false, false], '点了勾不能把勾点掉');
    assert.equal(store.getState().ledger.transfers.length, 3, '点勾也不写任何流水');
    page.onUnload();
  });
});

test('发薪日页：回退区块的 DOM 位置必须在步骤列表之后、分配编辑器之前', () => {
  // 用 wxml 的顺序钉住位置：早先它排在整个卡片最底部，前面隔着分配编辑器一大块，
  // 用户「没看到新增的按钮」就是这个原因。
  const fs = require('node:fs');
  const wxml = fs.readFileSync(require('node:path').join(__dirname, '../miniprogram/pages/payday/index.wxml'), 'utf8');
  const atSteps = wxml.indexOf('wx:for="{{steps}}"');
  const atUndo = wxml.indexOf('undo-button');
  const atSplit = wxml.indexOf('class="split-box"');
  const atSweep = wxml.lastIndexOf('sweepSurplus');
  assert.ok(atSteps >= 0 && atUndo >= 0 && atSplit >= 0, '三块都要在模板里');
  assert.ok(atUndo > atSteps, '回退要在步骤列表之后');
  assert.ok(atUndo < atSplit, '回退要在分配编辑器之前 —— 否则会被它顶到看不见的地方');
  assert.ok(atUndo < atSweep, '回退也要在余粮按钮之前');
});

test('回退到账：昨天登记的旧流水（没有 arrivalId）必须照样能整组退掉', () => {
  // 真实踩过的坑：arrivalId 是后加的字段，用户「昨天按的」那批流水根本没有它。
  // 早先把「缺 arrivalId」一律当 legacy_group 拒掉，等于这个功能只对修复之后登记的流水有效，
  // 而用户要退的恰恰是修复之前按下的那些。
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  // 手工模拟「同一毫秒一批写完」的旧流水：克里掉 arrivalId，保持同一个 createdAt
  const legacy = JSON.parse(JSON.stringify(store.getState()));
  legacy.ledger.transfers.forEach(item => { delete item.arrivalId; });
  assert.equal(store.restoreFromBackup(legacy).ok, true);
  const preview = store.previewArrivalUndo(1, D);
  assert.equal(preview.canUndo, true, '要按「同期次 + 同 createdAt + 同一天 + 流向正确」认回来');
  assert.deepEqual(preview.placements.map(item => item.kind), ['bill_repay', 'payday_budget']);
  assert.equal(store.undoArrival(1, D).removed, 3);
  assert.deepEqual(store.getState().ledger.transfers, []);
  assert.equal(Object.values(balancesOf()).reduce((total, value) => total + value, 0), 0);
});

test('回退到账：认组只看同批次的安置流水，当天别人记的支出/专项/手工划转不受影响', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  store.addExpense({ date: D, category: 'meal', amountYuan: '30.00' });
  store.addSpecial({ date: D, reason: 'Q4 水电', amountYuan: '50.00' });
  const before = store.getState();
  store.undoArrival(1, D);
  const after = store.getState();
  assert.equal(after.ledger.expenses.length, before.ledger.expenses.length, '别人的支出不能跟着被删');
  assert.equal(after.ledger.specials.length, before.ledger.specials.length, '专项也不能被删');
  assert.deepEqual(after.ledger.transfers, [], '只删这一组的 3 笔');
  assert.equal(Object.values(balancesOf()).reduce((total, value) => total + value, 0), 0);
});

test('第六步入口要等两笔到齐：生活费没到时的「余粮」里混着待补的池子钱', () => {
  // 钱没到齐时预算池还差 pendingPool 才满，此时算出的余粮里有一部分正是生活费待补的钱，
  // 清走等于提前把生活费花掉（实测 9/26 会清走 ¥110.38，而生活费 9/28 才到账）。
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  freezeAt([2026, 8, 26, 10, 0, 0], () => {
    const page = mount('../miniprogram/pages/payday/index.js');
    page.onLoad();
    page.setData({ periodIndex: 1 });
    page.refresh();
    const period = store.getState().periods[0];
    assert.equal(period.fullyFunded, false);
    assert.equal(page.data.canSweep, false, '没到齐就不该给清理入口');
    assert.match(page.data.sweepText, /等生活费到账、预算池补满之后再清理/);
    // 到齐之后才出现，且清的确实是真余粮（池子已经满员）
    store.registerAllowance(1, { date: '2026-09-28', asOfDate: '2026-09-28' });
    page.refresh();
    assert.equal(page.data.canSweep, true);
    assert.match(page.data.sweepText, /清理余额宝余粮/);
    const preview = store.previewPoolSurplus('2026-09-28');
    assert.equal(preview.pendingPool, 0, '池子已满，没有待补的钱混在里面');
  });
});

test('储蓄页的余粮卡片与发薪日页同一个门槛', () => {
  useWx();
  store.reset();
  store.registerSalaryDay(1, D);
  freezeAt([2026, 8, 26, 10, 0, 0], () => {
    const page = mount('../miniprogram/pages/pocket/index.js');
    page.onLoad();
    assert.equal(page.data.surplusCard, null, '钱没到齐时不给「确认转入小荷包」的入口');
    store.registerAllowance(1, { date: '2026-09-28', asOfDate: '2026-09-28' });
    page.refresh();
    assert.ok(page.data.surplusCard, '到齐后正常出现');
    page.onUnload();
  });
});
