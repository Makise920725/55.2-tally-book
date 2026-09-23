// P2/P3 回归：分类去重与输入口径，以及微信运行环境的兼容底线。
// 金额换算只允许 domain/money 一处：页面自己乘 100 会让 1.005 在不同入口变成两分钱之差。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../miniprogram/store/store');
const { yuanToFen } = require('../miniprogram/domain/money');
const { exportPaydayIcs } = require('../miniprogram/utils/ics');

let toasts = [];
function useWx(options = {}) {
  const map = new Map();
  toasts = [];
  global.wx = {
    getStorageSync: key => (map.has(key) ? map.get(key) : ''),
    setStorageSync: (key, value) => map.set(key, value),
    removeStorageSync: key => map.delete(key),
    showToast: o => toasts.push(o.title),
    showModal: o => { if (o.success) o.success({ confirm: !options.modalCancel }); },
    navigateTo: () => {}
  };
  return map;
}

function mount(relative) {
  let config = null;
  global.Page = options2 => { config = options2; };
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

const D = '2026-09-24';

test('分类按名称去重，空白/超长/怪标记一律拒绝', () => {
  useWx();
  store.reset();
  assert.equal(store.addCategory({ id: 'c1', name: '   ' }).blocked, 'invalid', '空白名称不是名称');
  assert.equal(store.addCategory({ id: 'c2', name: '吃饭' }).blocked, 'duplicate_name', '默认分类里已经有吃饭，光按 id 去重挡不住');
  assert.equal(store.addCategory({ id: 'c3', name: '  吃饭  ' }).blocked, 'duplicate_name', '首尾空格不算两个分类');
  assert.equal(store.addCategory({ id: 'c4', name: '这是一个长得能用去撑爆按钮的分类名称' }).blocked, 'invalid');
  assert.equal(store.addCategory({ id: 'c5', name: '夜宵', mark: '夜宵烧烤' }).blocked, 'invalid', '标记最多两个字符');
  const ok = store.addCategory({ id: 'c6', name: ' 夜宵 ', mark: ' 夜 ' });
  assert.equal(ok.blocked, undefined);
  const saved = store.getState().categories.find(item => item.id === 'c6');
  assert.equal(saved.name, '夜宵', '存进账本的是 trim 后的名称');
  assert.equal(saved.mark, '夜');
  assert.equal(saved.custom, true);
  assert.equal(store.addCategory({ id: 'c6', name: '奶茶' }).blocked, 'duplicate', 'id 撞了也不能放行');
});

test('我的页分类入口把拒绝原因说成人话', () => {
  useWx();
  store.reset();
  const page = mount('../miniprogram/pages/me/index.js');
  page.onLoad();
  page.setData({ categoryName: '吃饭', categoryMark: '' });
  page.addCategory();
  assert.ok(toasts.some(title => title.includes('同名')), '同名要说清是同名，不是“已存在”');
  page.setData({ categoryName: '   ', categoryMark: '' });
  page.addCategory();
  assert.ok(toasts.some(title => title.includes('不合法')));
  page.setData({ categoryName: '夜宵', categoryMark: '夜' });
  page.addCategory();
  assert.equal(store.getState().categories.some(item => item.name === '夜宵'), true);
  page.onUnload();
});

test('部分冲正用领域层换算金额：1.005 元就是 101 分，页面不再自己乘 100', () => {
  useWx();
  freezeAt([2026, 8, 24, 10, 0, 0], () => {
    store.reset();
    store.addExpense({ date: D, category: 'meal', amountYuan: 30 });
    const id = store.getState().ledger.expenses[0].id;
    const page = mount('../miniprogram/pages/ledger/index.js');
    page.onLoad();
    page.setData({ partialAmount: '1.005' });
    page.reversePartial({ currentTarget: { dataset: { id, source: 'expenses', remaining: '30.00' } } });
    const reversal = store.getState().ledger.expenses.find(item => item.reversalOf === id);
    assert.ok(reversal, '确认后应追加一条负向冲正');
    assert.equal(reversal.amount, -yuanToFen('1.005'));
    assert.equal(reversal.amount, -101, '按字符串定位小数点，不是 Math.round(1.005 * 100) = 100');
    assert.equal(reversal.date, D, '冲正仍落在原始记录的日期上');
    page.onUnload();
  });
});

test('冲正金额超范围或不是数字时，store 挡下来且不动账本', () => {
  useWx();
  freezeAt([2026, 8, 24, 10, 0, 0], () => {
    store.reset();
    store.addExpense({ date: D, category: 'meal', amountYuan: 30 });
    const id = store.getState().ledger.expenses[0].id;
    const before = JSON.stringify(store.getState());
    assert.equal(store.reverseExpense({ id, amountYuan: '30.01', asOfDate: D }).blocked, 'bad_amount');
    assert.equal(store.reverseExpense({ id, amountYuan: '零', asOfDate: D }).blocked, 'bad_amount');
    assert.equal(store.reverseExpense({ id, amountYuan: '-5', asOfDate: D }).blocked, 'bad_amount');
    assert.equal(JSON.stringify(store.getState()), before, '被拒绝的冲正一笔都不落');
    // 不传金额 = 整笔冲正；分两次部分冲正后剩余可冲额归零
    assert.equal(store.reverseExpense({ id, amountYuan: '10', asOfDate: D }).blocked, undefined);
    assert.equal(store.reverseExpense({ id, amountYuan: '20', asOfDate: D }).blocked, undefined);
    assert.equal(store.reverseExpense({ id, asOfDate: D }).blocked, 'already_reversed');
  });
});

// ---- 兼容底线：ES2021 的 String.replaceAll / ES2022 的 Array.at 不能出现在小程序代码里 ----
function sourceFiles(dir, acc = []) {
  fs.readdirSync(dir).forEach(name => {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) sourceFiles(full, acc);
    else if (name.endsWith('.js')) acc.push(full);
  });
  return acc;
}

test('小程序源码不使用 replaceAll / at(-1) 这类较新 API', () => {
  const files = sourceFiles(path.join(__dirname, '../miniprogram'));
  assert.ok(files.length >= 20, '应当扫到全部源码文件');
  const offenders = [];
  files.forEach(file => {
    const text = fs.readFileSync(file, 'utf8');
    if (/\.replaceAll\s*\(/.test(text)) offenders.push(`${path.basename(file)}: replaceAll`);
    if (/\.at\s*\(\s*-/.test(text)) offenders.push(`${path.basename(file)}: Array/String.at(-n)`);
  });
  assert.deepEqual(offenders, [], '老基础库上没有这两个方法，必须用 split/join 与下标');
});

test('ICS 仍然是 RFC 5545 的形状：CRLF、UID、DATE 值不带连字符', () => {
  const text = exportPaydayIcs([{ index: 1, payDate: '2026-09-24', saveToPocket: 185517 }, { index: 5, payDate: '2027-01-25', saveToPocket: 391513 }]);
  const lines = text.split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines[lines.length - 1], '');
  assert.equal(lines.filter(line => line === 'END:VEVENT').length, 2);
  assert.ok(lines.includes('DTSTART;VALUE=DATE:20260924'), '日期压成 basic 格式');
  assert.ok(lines.includes('DTEND;VALUE=DATE:20260925'), 'DTEND 是次日的独占边界');
  assert.ok(lines.includes('DTSTART;VALUE=DATE:20270125'));
  assert.ok(lines.some(line => line.startsWith('UID:55kuai2-period-1@tally-book')));
  assert.ok(!/-\d{4}-/.test(text), '不允许漏出 YYYY-MM-DD 形式的日期');
});
