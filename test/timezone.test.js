// P3 回归：UTC+8 凌晨与跨时区运行时的「今天」判定。
// 小程序里所有业务日期都按本地墙钟算：一旦哪天有人改用 toISOString()，
// UTC+8 早上 8 点前就会把账记到昨天、把额度算给上一个批次。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '../miniprogram');

// 2026-09-23T23:30:00Z —— 在 Asia/Shanghai 是 09-24 早上 07:30（计划第一天）
const SCRIPT = `
const { todayKey } = require(${JSON.stringify(path.join(ROOT, 'domain/calendar.js'))});
const { formatCreatedAt } = require(${JSON.stringify(path.join(ROOT, 'domain/ledger-view.js'))});
const store = require(${JSON.stringify(path.join(ROOT, 'store/store.js'))});
const RealDate = Date;
const AT = new RealDate('2026-09-23T23:30:00Z');
class FakeDate extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(AT.getTime()); }
  static now() { return AT.getTime(); }
}
global.Date = FakeDate;
global.Page = () => {};
const map = new Map();
global.wx = {
  getStorageSync: key => (map.has(key) ? map.get(key) : ''),
  setStorageSync: (key, value) => map.set(key, value),
  removeStorageSync: key => map.delete(key)
};
const today = todayKey();
store.reset();
const expense = store.addExpense({ date: today, category: 'meal', amountYuan: 10 });
const allocation = store.allocateDay({ date: today });
const settlement = store.settleDay({ date: today });
console.log(JSON.stringify({
  today,
  created: formatCreatedAt('2026-09-24T00:30:00.000Z'),
  blocked: expense.blocked || null,
  allocatedDate: allocation.transfer ? allocation.transfer.date : null,
  refundedDate: settlement.transfer ? settlement.transfer.date : null,
  slotBatch: (store.getState().daySlots[today] || {}).batchStart || null
}));
`;

function runIn(tz) {
  const out = execFileSync(process.execPath, ['-e', SCRIPT], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
  return JSON.parse(out.trim().split('\n').pop());
}

test('Asia/Shanghai 早上七点半就是新的一天，账落在今天', () => {
  const result = runIn('Asia/Shanghai');
  assert.equal(result.today, '2026-09-24', '今天必须是本地墙钟那天，不能被 UTC 拖回昨天');
  assert.equal(result.created, '2026-09-24 08:30:00', '创建时间按本地时区渲染');
  assert.equal(result.blocked, null, '计划第一天可以记账');
  assert.equal(result.allocatedDate, '2026-09-24');
  assert.equal(result.slotBatch, '2026-09-24', '批次身份也按同一天建立');
  assert.equal(result.refundedDate, '2026-09-24');
});

test('同一时刻在 UTC / 西五区各自得到自己的“今天”，业务日期不穿越', () => {
  const utc = runIn('UTC');
  assert.equal(utc.today, '2026-09-23', 'UTC 视角此刻还在 23:30');
  assert.equal(utc.created, '2026-09-24 00:30:00');
  assert.equal(utc.blocked, 'not_started', 'UTC 视角下计划还没开始，store 不会把账记进未来');
  const ny = runIn('America/New_York');
  assert.equal(ny.today, '2026-09-23');
  assert.equal(ny.created, '2026-09-23 20:30:00', '夏令时 UTC-4 也要算对');
});
