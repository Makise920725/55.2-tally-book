// P2 回归：发薪日第五步的完成状态来自真实转账流水，不是执行发薪日时顺手打上的勾。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const store = require('../miniprogram/store/store');
const { ACCT } = require('../miniprogram/domain/ledger');

const D = '2026-09-24';
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

test('执行发薪日只登记前四步，第五步留给真实转账', () => {
  useWx();
  store.reset();
  store.executePayday(1, D);
  const state = store.getState();
  assert.deepEqual(['1-1', '1-2', '1-3', '1-4'].map(key => state.paydaySteps[key]), [true, true, true, true]);
  assert.equal(state.paydaySteps['1-5'], undefined, '第五步不能被顺手打勾');
  const status = store.paydayStepStatus(state, 1);
  assert.equal(status.transferDone, true);
  assert.equal(status.allDone, false, '没真的转存过余粮就不算五步完成');
  assert.equal(store.isPaydayStepDone(state, 1, 5), false);
});

test('第五步由本期内的 carry_over 流水派生，跨期不算', () => {
  useWx();
  store.reset();
  store.executePayday(1, D);
  store.executePayday(5, '2027-01-25');
  assert.equal(store.isPaydayStepDone(store.getState(), 1, 5), false);
  // 第 5 期末（截止日当天）清一次余粮：只有第 5 期变成已完成
  const swept = store.sweepPoolSurplus({ asOfDate: '2027-02-05' });
  assert.ok(swept.transfer && swept.transfer.kind === 'carry_over');
  const state = store.getState();
  assert.equal(store.isPaydayStepDone(state, 5, 5), true);
  assert.equal(store.paydayStepStatus(state, 5).allDone, true);
  assert.equal(store.isPaydayStepDone(state, 1, 5), false, '别的期次转的钱不算本期第五步');
  assert.equal(store.periodSweptFen(state, 5), swept.swept);
});

test('第五步不接受手动勾选或取消', () => {
  useWx();
  store.reset();
  const result = store.togglePaydayStep(1, 5, D);
  assert.equal(result.blocked, 'derived_step');
  assert.deepEqual(store.getState().paydaySteps, {}, '一个勾都不能因此出现');
  // 前四步仍然可以手动勾/取消（在计划期间内）
  assert.equal(store.togglePaydayStep(1, 3, D).blocked, undefined);
  assert.equal(store.getState().paydaySteps['1-3'], true);
  assert.equal(store.togglePaydayStep(1, 3, D).blocked, undefined);
  assert.equal(store.getState().paydaySteps['1-3'], false);
});

test('旧版本残留的 *-5 勾在装载/恢复时被清掉', () => {
  useWx();
  store.reset();
  const legacy = JSON.parse(JSON.stringify(store.getState()));
  legacy.paydaySteps = { '1-1': true, '1-2': true, '1-3': true, '1-4': true, '1-5': true, '3-5': true };
  store.restoreFromBackup(legacy);
  const state = store.getState();
  assert.equal(state.paydaySteps['1-5'], undefined);
  assert.equal(state.paydaySteps['3-5'], undefined);
  assert.equal(state.paydaySteps['1-1'], true, '前四步的勾照旧保留');
  assert.equal(store.isPaydayStepDone(state, 1, 5), false, '陈旧勾不能冒充第五步完成');
});

test('发薪日页：只有真实转存后才显示「五步完成」', () => {
  useWx();
  freezeAt([2026, 9, 22, 10, 0, 0], () => {        // 2026-10-22，第 1 期最后一天
    store.reset();
    store.executePayday(1, D);
    const page = mount('../miniprogram/pages/payday/index.js');
    page.onLoad();
    page.setData({ periodIndex: 1 });
    page.refresh();
    assert.deepEqual(page.data.steps.map(item => item.done), [true, true, true, true, false]);
    assert.equal(page.data.transferDone, true);
    assert.equal(page.data.allDone, false);
    assert.match(page.data.statusText, /第五步余粮还没转进小荷包/);
    assert.equal(page.data.completed, false, '完成标记不能被前四步点亮');

    // 点第五步那一行：只解释，不改状态
    page.toggleStep({ currentTarget: { dataset: { step: 5 } } });
    assert.ok(toasts.some(title => title.includes('真实转存')), '要说清楚第五步是真实转存');
    assert.equal(store.getState().paydaySteps['1-5'], undefined);

    // 真实转存一次余粮：页面立刻按流水点亮第五步
    const swept = store.sweepPoolSurplus({ asOfDate: PERIOD1_END });
    assert.ok(swept.swept > 0, '期末应当有余粮可清');
    page.refresh();
    assert.equal(page.data.steps[4].done, true);
    assert.match(page.data.steps[4].amount, new RegExp(`本期已转存小荷包 ¥${(swept.swept / 100).toFixed(2)}`));
    assert.equal(page.data.allDone, true);
    assert.equal(page.data.completed, true);
    assert.match(page.data.statusText, /五步完成/);
    page.onUnload();
  });
});

test('发薪日页：截止日之后执行按钮只说只读，不再登记流水', () => {
  useWx();
  freezeAt([2027, 1, 6, 10, 0, 0], () => {          // 2027-02-06
    store.reset();
    const page = mount('../miniprogram/pages/payday/index.js');
    page.onLoad();
    page.setData({ periodIndex: 5 });
    page.execute();
    assert.ok(toasts.some(title => title.includes('只读')), '要告诉用户账本已只读');
    assert.equal(store.getState().ledger.transfers.filter(item => item.kind === 'payday_income').length, 0);
    page.onUnload();
  });
});
