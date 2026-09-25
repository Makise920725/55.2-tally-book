// 今日页顶部那张待办清单 = 「今天还差几件事」。
// 它取代了原来 tab 栏上那颗只会给数字、用户看不懂的红点（「①」）——
// 现在只保留这张清单，逐条写清还差哪一步：早间划额 / 晚间结算 / 待登记工资 / 待登记生活费。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const D = '2026-09-24';
const at = (y, m, d) => [y, m - 1, d, 9, 0, 0];

// 在冻结的「今天」里装配 store + 今日页，回调跑完再解冻（写账触发的刷新也要在冻结期内）。
function withToday(dateParts, handler) {
  const map = new Map();
  global.wx = {
    getStorageSync: key => (map.has(key) ? map.get(key) : ''),
    setStorageSync: (key, value) => map.set(key, value),
    removeStorageSync: key => map.delete(key),
    showToast: () => {},
    showModal: options => { if (options.success) options.success({ confirm: true }); }
  };
  Object.keys(require.cache).forEach(key => { if (key.startsWith(ROOT)) delete require.cache[key]; });
  const store = require(path.join(ROOT, 'miniprogram/store/store'));
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(...dateParts); }
    static now() { return new RealDate(...dateParts).getTime(); }
  }
  global.Date = FakeDate;
  try {
    let pageConfig = null;
    global.Page = config => { pageConfig = config; };
    const pagePath = require.resolve(path.join(ROOT, 'miniprogram/pages/today/index.js'));
    delete require.cache[pagePath];
    require(pagePath);
    const page = { data: { ...pageConfig.data } };
    Object.keys(pageConfig).forEach(key => {
      if (typeof pageConfig[key] === 'function') page[key] = pageConfig[key].bind(page);
      else if (key !== 'data') page[key] = pageConfig[key];
    });
    page.setData = function (patch) { Object.assign(this.data, patch); };
    page.onLoad();
    const unsubscribe = store.subscribe(() => page.refresh());
    const todos = () => { page.refresh(); return page.data.todos; };
    try {
      return handler({ store, todos });
    } finally {
      unsubscribe();
    }
  } finally {
    global.Date = RealDate;
  }
}

test('空账本的工资日：欠「登记工资」和「划额」两件', () => {
  withToday(at(2026, 9, 24), ({ todos }) => {
    assert.deepEqual(todos().map(item => item.key), ['allocate', 'salary']);
    assert.match(todos()[0].text, /早间划额/);
    assert.match(todos()[1].text, /工资到账还没登记/);
  });
});

test('清单跟着账本实时变：登记工资 → 划额 → 封账，一件一件做完', () => {
  withToday(at(2026, 9, 24), ({ store, todos }) => {
    assert.equal(todos().length, 2, '空账本欠两件');
    store.registerSalaryDay(1, D);
    assert.deepEqual(todos().map(item => item.key), ['allocate'], '登记工资后只剩划额');
    store.allocateDay({ date: D });
    assert.deepEqual(todos().map(item => item.key), ['settle'], '划完换成「欠结算」');
    assert.match(todos()[0].text, /晚间结算/);
    store.addExpense({ date: D, category: 'meal', amountYuan: 20 });
    store.settleDay({ date: D });
    assert.deepEqual(todos(), [], '封账 = 今天的事做完了，清单清空');
  });
});

test('三日批次的前两天不用结算，清单里不该出现「晚间结算」', () => {
  // 批次是 09-24 ~ 09-26，09-25 是中段：那天结算只会得到 batchPending，本来就没事可做。
  withToday(at(2026, 9, 25), ({ store, todos }) => {
    store.setMode('three-day', D);
    store.registerSalaryDay(1, D);
    store.allocateDay({ date: D });
    assert.equal(store.settleDay({ date: '2026-09-25' }).batchPending, true, '批次末日才结算');
    assert.deepEqual(todos(), [], 'batchPending 不是待办');
  });
  withToday(at(2026, 9, 26), ({ store, todos }) => {
    store.setMode('three-day', D);
    store.registerSalaryDay(1, D);
    store.allocateDay({ date: D });
    assert.deepEqual(todos().map(item => item.key), ['settle'], '到了批次末日就是真待办');
  });
});

test('生活费漏登会一直列在清单里，且指向补登入口', () => {
  withToday(at(2026, 9, 28), ({ store, todos }) => {
    store.registerSalaryDay(1, D);
    store.allocateDay({ date: '2026-09-28' });
    store.settleDay({ date: '2026-09-28' });
    assert.deepEqual(todos().map(item => item.key), ['allowance'], '今天结完了，但生活费到了预计日还没登记');
    assert.match(todos()[0].text, /第 1 期生活费还没登记/);
    assert.match(todos()[0].text, /2026-09-28/);
    store.registerAllowance(1, { date: '2026-09-28', asOfDate: '2026-09-28' });
    assert.deepEqual(todos(), [], '登记完就清空');
  });
});

test('生活费漏登是跨期的：人走进第 2 期也照样提醒第 1 期', () => {
  withToday(at(2026, 10, 25), ({ store, todos }) => {
    store.registerSalaryDay(1, D);
    store.registerSalaryDay(2, '2026-10-23');
    const keys = todos().map(item => item.key);
    assert.deepEqual(keys, ['allocate', 'allowance']);
    assert.match(todos()[1].text, /本期区间已过/, '逾期要给出补登路径');
    assert.match(todos()[1].text, /实际到账日/);
  });
});

test('计划未开始 / 已结束：清单不出现', () => {
  withToday(at(2026, 9, 1), ({ todos }) => assert.deepEqual(todos(), []));
  withToday(at(2027, 2, 6), ({ todos }) => assert.deepEqual(todos(), []));
});
