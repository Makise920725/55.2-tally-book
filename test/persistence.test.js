// P1 回归：写入必须先落盘、后换内存。
// 只要本机存储写不进去，内存里的账本就必须一个字都不变 —— 屏幕上看到的就是重启后还能拿到的。
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../miniprogram/store/store');
const write = require('../miniprogram/utils/write');

const write_fail_text = () => write.PERSIST_FAILED;
const { ACCT } = require('../miniprogram/domain/ledger');

const MAIN_KEY = 'p5519';
const D = '2026-09-24';
const LAST = '2027-02-05';        // 计划截止日（当天仍可写）
const AFTER = '2027-02-06';       // 截止日之后（账本只读）

let toasts = [];

// 真写进去的存储：用于把状态铺到「可以操作」的形状
function workingStorage() {
  const map = new Map();
  global.wx = {
    getStorageSync: key => (map.has(key) ? map.get(key) : ''),
    setStorageSync: (key, value) => map.set(key, value),
    removeStorageSync: key => map.delete(key),
    showToast: options => toasts.push(options.title)
  };
  return map;
}

// 主账本写不进（超出 storage 上限）：其余键照常，方便测出「只有落盘失败」的行为
function failingStorage() {
  const map = new Map();
  global.wx = {
    getStorageSync: key => (map.has(key) ? map.get(key) : ''),
    setStorageSync: (key, value) => {
      if (key === MAIN_KEY) throw new Error('exceed storage limit');
      map.set(key, value);
    },
    removeStorageSync: key => map.delete(key),
    showToast: options => toasts.push(options.title)
  };
  return map;
}

const snapshot = () => JSON.stringify(store.getState());

// 每条：先在工作存储里铺场景，再换成坏存储执行同一个写入口。
// 每条：setup 在能写的存储里把状态铺好，run 才是「换成坏存储后要试的写入口」。
const WRITE_ENTRIES = [
  ['addExpense', () => {}, () => store.addExpense({ date: D, category: 'meal', amountYuan: 12 })],
  ['addSpecial', () => {}, () => store.addSpecial({ date: D, reason: 'Q4 水电', amountYuan: 30 })],
  ['addAdjust', () => {}, () => store.addAdjust({ date: D, acct: ACCT.BANK1, realBalanceYuan: 100, bookBalanceYuan: 90 })],
  ['allocateDay', () => {}, () => store.allocateDay({ date: D })],
  ['settleDay',
    () => { store.allocateDay({ date: D }); store.addExpense({ date: D, category: 'meal', amountYuan: 10 }); },
    () => store.settleDay({ date: D })],
  ['reopenDay',
    () => { store.allocateDay({ date: D }); store.addExpense({ date: D, category: 'meal', amountYuan: 10 }); store.settleDay({ date: D }); },
    () => store.reopenDay(D)],
  ['executePayday', () => {}, () => store.executePayday(1, D)],
  ['setMode', () => store.setMode('three-day', D), () => store.setMode('daily', D)],
  ['setScenario', () => {}, () => store.setScenario('省', D)],
  ['registerSalaryDay', () => {}, () => store.registerSalaryDay(1, D)],
  ['registerAllowance', () => store.registerSalaryDay(1, D), () => store.registerAllowance(1, { date: '2026-09-28', asOfDate: '2026-09-28' })],
  ['addCategory', () => {}, () => store.addCategory({ id: store.newCategoryId(), name: '夜宵', mark: '夜' })],
  ['removeCategory', () => {}, () => store.removeCategory('fun')],
  ['reverseExpense', () => store.addExpense({ date: D, category: 'meal', amountYuan: 10 }),
    () => store.reverseExpense({ id: store.getState().ledger.expenses[0].id, asOfDate: D })],
  ['reverseSpecial', () => store.addSpecial({ date: D, reason: '误记', amountYuan: 10 }),
    () => store.reverseSpecial({ id: store.getState().ledger.specials[0].id, asOfDate: D })],
  ['sweepPoolSurplus', () => store.executePayday(5, LAST), () => store.sweepPoolSurplus({ asOfDate: LAST })],
  ['reset', () => store.addExpense({ date: D, category: 'meal', amountYuan: 8 }), () => store.reset()]
];

test('每一个写入口在存储失败时都不改变内存状态', () => {
  WRITE_ENTRIES.forEach(([name, setup, operation]) => {
    toasts = [];
    workingStorage();
    store.reset();
    setup();
    const before = snapshot();
    failingStorage();
    const result = operation();
    assert.equal(result.persisted, false, `${name} 必须报告 persisted:false`);
    assert.equal(snapshot(), before, `${name} 失败后内存账本必须原封不动`);
  });
});

test('存储失败时余额、期次、批次登记都不会凭空出现', () => {
  workingStorage();
  store.reset();
  const empty = store.getState();
  const ledgerShape = { expenses: 0, transfers: 0, specials: 0, adjusts: 0 };
  failingStorage();
  store.addExpense({ date: D, category: 'meal', amountYuan: 12 });
  store.allocateDay({ date: D });
  store.executePayday(1, D);
  const state = store.getState();
  assert.deepEqual({
    expenses: state.ledger.expenses.length, transfers: state.ledger.transfers.length,
    specials: state.ledger.specials.length, adjusts: state.ledger.adjusts.length
  }, ledgerShape, '一笔都不该落进账本');
  assert.deepEqual(Object.keys(state.executedPaydays), [], '发薪日不能被标成已执行');
  assert.deepEqual(state.daySlots, {}, '批次身份不能被登记');
  assert.equal(state.config.dailyBudget, empty.config.dailyBudget, '情景不能变');
  assert.equal(store.getState() === state, true);
});

test('落盘成功后才替换内存状态并通知页面', () => {
  const map = workingStorage();
  store.reset();
  const result = store.addExpense({ date: D, category: 'meal', amountYuan: 12 });
  assert.equal(result.persisted, true);
  assert.equal(store.getState().ledger.expenses.length, 1);
  assert.ok(String(map.get(MAIN_KEY)).includes('"amount":1200'), '持久化里必须真有这笔账');
});

test('恢复与撤销恢复：写不进去就退回原账本，不留半套状态', () => {
  workingStorage();
  store.reset();
  store.addExpense({ date: D, category: 'meal', amountYuan: 20 });
  const before = snapshot();

  failingStorage();
  const failed = store.restoreFromBackup({ config: { startDate: D, deadline: LAST, dailyBudget: 5519 }, ledger: { expenses: [], transfers: [], specials: [], adjusts: [] } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'persist-failed');
  assert.equal(snapshot(), before, '恢复失败，内存仍是原账本');

  // 换回能写的存储：恢复成功，撤销恢复也成功，两步都各自落盘
  workingStorage();
  const ok = store.restoreFromBackup({ config: { startDate: D, deadline: LAST, dailyBudget: 5519 }, ledger: { expenses: [], transfers: [], specials: [], adjusts: [] } });
  assert.equal(ok.ok, true);
  assert.equal(store.getState().ledger.expenses.length, 0);
  const undone = store.undoRestore();
  assert.equal(undone.ok, true);
  assert.equal(store.getState().ledger.expenses.length, 1, '撤销恢复回到恢复前那笔 20 元');
});

function freezeAt(parts, handler) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(...parts); }
    static now() { return new RealDate(...parts).getTime(); }
  }
  global.Date = FakeDate;
  try { handler(); } finally { global.Date = RealDate; }
}

test('页面：写失败时说「没有保存」而不是「已记一笔」', () => {
  const path = require('node:path');
  let config = null;
  global.Page = options => { config = options; };
  const target = require.resolve(path.join(__dirname, '../miniprogram/pages/today/index.js'));
  delete require.cache[target];
  require(target);
  const page = { data: { ...config.data } };
  Object.keys(config).forEach(key => {
    if (typeof config[key] === 'function') page[key] = config[key].bind(page);
    else if (key !== 'data') page[key] = config[key];
  });
  page.setData = function (patch) { Object.assign(this.data, patch); };

  workingStorage();
  freezeAt([2026, 8, 24, 10, 0, 0], () => {
    store.reset();
    page.onLoad();                       // refresh() 之后才有 active/today 这些判定
    toasts = [];
    failingStorage();
    page.keypress({ currentTarget: { dataset: { key: '1' } } });
    page.addExpense();
    assert.ok(toasts.some(title => title.includes('没有保存')), '必须提示未保存');
    assert.equal(toasts.some(title => title === '已记一笔'), false, '绝不能说已记账');
    assert.equal(page.data.keypadAmount, '1', '输入原样留着，让用户重试');
    assert.equal(store.getState().ledger.expenses.length, 0);
    assert.equal(page.data.saveError, write_fail_text(), '横幅与提示同一句话');

    // 恢复可写后同一笔能正常落地，横幅清空
    workingStorage();
    page.addExpense();
    assert.equal(store.getState().ledger.expenses.length, 1);
    assert.equal(page.data.saveError, '');
    assert.equal(page.data.keypadAmount, '0', '真的落盘后才清输入框');
    page.onUnload();
  });
});
