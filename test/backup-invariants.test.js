// P3 回归：备份解析分两层——结构校验（能不能读）+ 账务不变量校验（读进来会不会算错账）。
// 恶意或被截断的备份一旦通过校验被恢复，批次退款、余粮、目标储蓄都会静默算错，所以这里逐条钉住。
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../miniprogram/store/store');
const backup = require('../miniprogram/utils/backup');
const { ACCT } = require('../miniprogram/domain/ledger');

const D = '2026-09-24';
const LAST = '2027-02-05';

function useWx() {
  const map = new Map();
  global.wx = {
    getStorageSync: key => (map.has(key) ? map.get(key) : ''),
    setStorageSync: (key, value) => map.set(key, value),
    removeStorageSync: key => map.delete(key),
    showToast: () => {}
  };
  return map;
}

// 一份「真跑出来」的账本：划额、支出、超支补差、结算、专项、冲正、校准、发薪日、清理余粮都有
function richBackupText() {
  useWx();
  store.reset();
  store.executePayday(1, D);
  store.allocateDay({ date: D });
  store.addExpense({ date: D, category: 'meal', amountYuan: 70 });   // 超支 → 自动补差
  store.settleDay({ date: D });
  store.addSpecial({ date: D, reason: 'Q4 水电', amountYuan: 405.88 });
  const specialId = store.getState().ledger.specials[0].id;
  store.reverseSpecial({ id: specialId, amountYuan: 5.88, asOfDate: D });
  store.addAdjust({ date: '2026-09-20', acct: ACCT.BANK1, realBalanceYuan: 120, bookBalanceYuan: 100, note: '期初对账' });
  store.executePayday(5, LAST);
  store.sweepPoolSurplus({ asOfDate: LAST });
  return backup.createBackupText(store.getState());
}

const tamper = (text, mutate) => {
  const copy = JSON.parse(text);
  mutate(copy);
  return JSON.stringify(copy);
};

const reject = (text, pattern, message) => {
  const parsed = backup.parseBackupText(text);
  assert.equal(parsed.ok, false, message || '应当拒绝恢复');
  assert.match((parsed.problems || []).join(' '), pattern, message);
  return parsed;
};

test('真实账本的备份能通过两层校验并原样恢复', () => {
  const text = richBackupText();
  const parsed = backup.parseBackupText(text);
  assert.equal(parsed.ok, true, (parsed.problems || []).join(' | '));
  const before = JSON.stringify(store.getState());
  assert.equal(JSON.stringify(store.getState()), before, '解析本身不碰账本');
  assert.equal(store.restoreFromBackup(parsed.state).ok, true);
});

test('划转的两端必须是已知账户且不能自己转给自己', () => {
  const text = richBackupText();
  reject(tamper(text, o => { o.state.ledger.transfers[0].to = o.state.ledger.transfers[0].from; }), /同一个账户/);
  reject(tamper(text, o => { o.state.ledger.transfers[0].from = 'WALLET'; }), /不在账本账户集合/);
  reject(tamper(text, o => { o.state.ledger.expenses[0].account = 'MYSTERY'; }), /expenses .*不在账本账户集合/);
  reject(tamper(text, o => { o.state.ledger.specials[0].from = 'MYSTERY'; }), /specials .*不在账本账户集合/);
  reject(tamper(text, o => { o.state.ledger.adjusts[0].acct = 'MYSTERY'; }), /adjusts .*不在账本账户集合/);
});

test('划转类型必须认识，否则余额派生会漏算这一笔', () => {
  const text = richBackupText();
  reject(tamper(text, o => { o.state.ledger.transfers[0].kind = 'free_money'; }), /划转类型 .*无法识别/);
  // 白名单里的每种真实 kind 都必须放行：改一笔划额流水（不动发薪流水，免得撞「已执行期次」那条）
  const allocIndex = JSON.parse(text).state.ledger.transfers.findIndex(item => item.kind === 'daily_alloc');
  ['payday_income', 'bill_repay', 'payday_budget', 'payday_save', 'daily_alloc', 'overspend_cover', 'daily_refund', 'carry_over']
    .forEach(kind => {
      // 生活费到账有固定金额/日期口径，单独在下面验证，不能拿一笔划额流水改个名字蒙混。
      const parsed = backup.parseBackupText(tamper(text, o => { o.state.ledger.transfers[allocIndex].kind = kind; }));
      assert.equal(parsed.ok, true, `${kind} 应被放行：${(parsed.problems || []).join(' | ')}`);
    });
  // 生活费到账：金额固定 2,000、必须落在本期区间，且不能写成同一天的工资
  const allowanceIndex = JSON.parse(text).state.ledger.transfers.findIndex(item => item.kind === 'allowance_income');
  assert.ok(allowanceIndex >= 0, '真实账本里应当有生活费到账流水');
  reject(tamper(text, o => { o.state.ledger.transfers[allowanceIndex].amount = 199900; }), /生活费金额必须是 ¥2,000\.00/);
  reject(tamper(text, o => { o.state.ledger.transfers[allowanceIndex].date = '2027-03-01'; }), /生活费到账日不在第 1 期|生活费到账日/);
  reject(tamper(text, o => { o.state.ledger.transfers.push({ ...o.state.ledger.transfers[allowanceIndex], id: 'allow_dup', amount: 200000 }); }), /登记了 2 笔生活费/);
});

test('批次身份不能重叠、不能把日子甩在批次外', () => {
  const text = richBackupText();
  reject(tamper(text, o => { o.state.daySlots[D].batchStart = '2026-09-27'; o.state.daySlots[D].batchEnd = '2026-09-26'; }), /批次范围不合法/, '批次起点晚于终点');
  reject(tamper(text, o => { o.state.daySlots[D].batchStart = '2026-09-20'; o.state.daySlots[D].batchEnd = '2026-09-22'; }), /落在自己批次范围/, '这一天被甩在它自己的批次之外');
  reject(tamper(text, o => {
    o.state.daySlots['2026-09-25'] = { batchStart: '2026-09-25', batchEnd: '2026-09-26', batchMode: 'three-day' };
    o.state.daySlots[D].batchStart = '2026-09-24';
    o.state.daySlots[D].batchEnd = '2026-09-26';
  }), /互相重叠/);
  reject(tamper(text, o => { o.state.daySlots[D].allocated = -1; }), /非负整数分/);
  reject(tamper(text, o => { o.state.daySlots[D].closed = 'yes'; }), /必须是布尔值/);
  reject(tamper(text, o => { o.state.daySlots.nope = { allocated: 100 }; }), /不是合法日期/);
  reject(tamper(text, o => { o.state.daySlots[D].batchMode = 'weekly'; }), /batchMode 无法识别/);
});

test('已执行发薪日必须有对应的工资到账流水', () => {
  const text = richBackupText();
  reject(tamper(text, o => { o.state.ledger.transfers[0].date = '2026-9-24'; }), /业务日期不合法/, '划转的业务日期必须是 YYYY-MM-DD');
  reject(tamper(text, o => { o.state.executedPaydays = { 3: true }; }), /第 3 期标记为已执行/, '没有到账流水的“已执行”会把目标储蓄额算虚');
  reject(tamper(text, o => { o.state.executedPaydays = { 9: true }; }), /期次 9 不存在/);
  // 真实执行过第 1、5 期的备份照常通过
  assert.equal(backup.parseBackupText(tamper(text, o => { o.state.executedPaydays = { 1: true, 5: true }; })).ok, true);
});

test('SOP 勾选只能是五期 × 五步的布尔值', () => {
  const text = richBackupText();
  reject(tamper(text, o => { o.state.paydaySteps = { '1-9': true }; }), /不属于五期 × 六步/);
  assert.equal(backup.parseBackupText(tamper(text, o => { o.state.paydaySteps = { '1-6': true }; })).ok, true, '历史勾最多到第六步');
  reject(tamper(text, o => { o.state.paydaySteps = { '2-3': 'done' }; }), /必须是布尔值/);
});

test('计划参数与模式必须自洽', () => {
  const text = richBackupText();
  reject(tamper(text, o => { o.state.config.deadline = '2026-01-01'; }), /晚于截止日/);
  reject(tamper(text, o => { o.state.config.scenario = '躺平'; }), /预算情景 .*无法识别/);
  reject(tamper(text, o => { o.state.mode = 'weekly'; }), /结算模式 .*无法识别/);
  reject(tamper(text, o => { o.state.categories[0].name = ''; }), /缺少 id 或名称/);
  reject(tamper(text, o => { o.state.ledger.adjusts[0].diff = 1; }), /差额与两项余额对不上/);
  reject(tamper(text, o => { o.state.ledger.expenses[0].note = '哈'.repeat(600); }), /备注过长/);
});

test('缺字段的老备份照样放行：默认值交给迁移补齐', () => {
  const text = richBackupText();
  const parsed = backup.parseBackupText(tamper(text, o => {
    delete o.state.mode; delete o.state.categories; delete o.state.daySlots; delete o.state.executedPaydays; delete o.state.paydaySteps;
  }));
  assert.equal(parsed.ok, true, (parsed.problems || []).join(' | '));
  const restored = store.restoreFromBackup(parsed.state);
  assert.equal(restored.ok, true);
  const state = store.getState();
  assert.equal(state.mode, 'daily');
  assert.deepEqual(state.daySlots, {});
  assert.ok(state.categories.length >= 8, '分类回落到默认表');
  assert.equal(state.periods.length, 5, '期次永远按流水重算');
});
