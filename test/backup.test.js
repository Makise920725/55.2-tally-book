const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const store = require('../miniprogram/store/store');
const backup = require('../miniprogram/utils/backup');
const { ACCT } = require('../miniprogram/domain/ledger');
const { SCHEMA_VERSION } = require('../miniprogram/utils/storage');

const D = '2026-09-24';

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

// 真正的 KV 存储：回滚槽位、元信息、恢复失败回退都要靠它
let currentCalls = null;

function installWx(options = {}) {
  const map = new Map();
  const calls = { toast: [], modal: [], shared: [], opened: [], chosen: 0, map };
  global.wx = {
    env: { USER_DATA_PATH: '/tmp/tally-backup' },
    getStorageSync: key => (map.has(key) ? map.get(key) : ''),
    setStorageSync: (key, value) => {
      if (options.failMainWrite && key === 'p5519') throw new Error('exceed storage limit');
      map.set(key, value);
    },
    removeStorageSync: key => map.delete(key),
    showToast: o => calls.toast.push(o.title),
    showModal: o => {
      calls.modal.push({ title: o.title, content: o.content });
      if (o.success) o.success({ confirm: !options.modalCancel });
    },
    getClipboardData: o => o.success({ data: options.clipboardText || '' }),
    chooseMessageFile: o => {
      calls.chosen += 1;
      if (options.chooseFails) { o.fail({}); return; }
      o.success({ tempFiles: [{ path: '/tmp/tally-backup/in.json' }] });
    },
    getFileSystemManager: () => ({
      writeFileSync: (file, content) => { map.set(`file:${file}`, content); },
      readFile: o => o.success({ data: options.fileText === undefined ? '' : options.fileText })
    }),
    shareFileMessage: o => { calls.shared.push(o.fileName); if (options.shareFails) o.fail({}); else o.success({}); },
    openDocument: o => { calls.opened.push(o.filePath); if (options.openFails) o.fail({}); else o.success({}); }
  };
  currentCalls = calls;
  return calls;
}

function buildLedger() {
  store.reset();
  store.allocateDay({ date: D });
  store.addExpense({ date: D, category: 'meal', amountYuan: 30 });
  store.addSpecial({ date: D, reason: 'Q4 水电', amountYuan: 405.88 });
  store.addAdjust({ date: D, acct: ACCT.POCKET3, realBalanceYuan: 100, bookBalanceYuan: 120 });
  store.executePayday(1, D);
  store.settleDay({ date: D });
  return store.getState();
}

// 需要“当前 wx 与 calls 是同一个”的用例，一律先 install 再 build
function seedLedger(options) {
  const calls = installWx(options);
  buildLedger();
  return calls;
}

const clone = value => JSON.parse(JSON.stringify(value));

test('备份是完整快照，恢复后与导出前逐字段一致', () => {
  seedLedger();
  const state = store.getState();
  const text = backup.createBackupText(clone(state));
  const parsed = backup.parseBackupText(text);
  assert.equal(parsed.ok, true);
  const restored = store.restoreFromBackup(parsed.state);
  assert.equal(restored.ok, true);
  const snapshot = clone(store.getState());
  delete snapshot.schemaVersion;
  const original = clone(state);
  delete original.schemaVersion;
  assert.deepEqual(snapshot, original);
  assert.equal(snapshot.daySlots[D].closed, true, '封账状态必须一起回来');
  assert.equal(Object.keys(snapshot.executedPaydays).length, 1, '已执行发薪日必须一起回来');
});

test('备份文件命名与账本摘要', () => {
  seedLedger();
  const state = store.getState();
  assert.equal(backup.backupFileName('20260924-083000'), '55kuai2-backup-20260924-083000.json');
  assert.equal(backup.describeState(state), '支出 1 笔 · 划转 6 笔 · 专项 1 笔 · 校准 1 条');
  const text = JSON.parse(backup.createBackupText(state));
  assert.equal(text.format, 'tally-book-backup');
  assert.equal(text.schemaVersion, SCHEMA_VERSION);
  assert.ok(text.exportedAt.endsWith('Z'));
});

test('会写坏账本的备份一律拒绝恢复', () => {
  seedLedger();
  const good = JSON.parse(backup.createBackupText(store.getState()));
  const tamper = mutate => { const copy = JSON.parse(JSON.stringify(good)); mutate(copy); return JSON.stringify(copy); };
  assert.equal(backup.parseBackupText('').ok, false);
  assert.equal(backup.parseBackupText('不是 JSON').ok, false);
  assert.equal(backup.parseBackupText(JSON.stringify({ foo: 1 })).ok, false, '别的 App 的 JSON');
  assert.equal(backup.parseBackupText(tamper(o => { o.formatVersion = 99; })).ok, false);
  assert.equal(backup.parseBackupText(tamper(o => { o.schemaVersion = SCHEMA_VERSION + 1; })).ok, false, '更高版本要拒绝，避免旧代码吃掉新字段');
  assert.equal(backup.parseBackupText(tamper(o => { o.state.ledger.expenses[0].amount = 12.5; })).ok, false, '金额必须是整数分');
  assert.equal(backup.parseBackupText(tamper(o => { o.state.ledger.expenses[0].date = '2026/09/24'; })).ok, false);
  assert.equal(backup.parseBackupText(tamper(o => { o.state.ledger.expenses.push(o.state.ledger.expenses[0]); })).ok, false, 'id 不能重复');
  assert.equal(backup.parseBackupText(tamper(o => { o.state.ledger.expenses[0].reversalOf = 'ghost'; })).ok, false, '冲正必须指向存在的原单');
  assert.equal(backup.parseBackupText(tamper(o => { delete o.state.config.dailyBudget; })).ok, false);
  const rejected = backup.parseBackupText(tamper(o => { o.state.ledger.expenses[0].amount = -100; }));
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(''), /正整数分/);
  // 拒绝时账本一个字都不能变
  const before = clone(store.getState());
  assert.equal(backup.parseBackupText('{').ok, false);
  assert.deepEqual(clone(store.getState()), before, '解析失败完全不碰账本');
});

test('旧版本备份恢复时会补齐缺失字段', () => {
  seedLedger();
  const state = store.getState();
  const legacy = clone(state);
  delete legacy.daySlots;
  delete legacy.schemaVersion;
  legacy.ledger.specials = [];
  legacy.periods = [];
  const parsed = backup.parseBackupText(backup.createBackupText(legacy));
  assert.equal(parsed.ok, true);
  const restored = store.restoreFromBackup(parsed.state);
  assert.equal(restored.ok, true);
  const next = store.getState();
  assert.deepEqual(next.daySlots, {});
  assert.equal(next.schemaVersion, SCHEMA_VERSION);
  assert.equal(next.periods.length, 5, '缺失的期次会按当前日额度重算');
});

test('恢复失败不留半套：写不进 storage 就退回原账本', () => {
  const state = seedLedger();
  const text = backup.createBackupText({ config: { startDate: '2099-01-01', deadline: '2099-12-31', dailyBudget: 100 }, ledger: { expenses: [], transfers: [], specials: [], adjusts: [] } });
  const parsed = backup.parseBackupText(text);
  assert.equal(parsed.ok, true);
  installWx({ failMainWrite: true });
  store.reset();
  const before = clone(store.getState());
  const failed = store.restoreFromBackup(parsed.state);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'persist-failed');
  assert.deepEqual(clone(store.getState()), before, '内存里的账本也要退回原状');
});

test('撤销恢复与误点重置都能救回来', () => {
  seedLedger();
  const before = clone(store.getState());
  const other = clone(before);
  other.ledger.expenses = [];
  assert.equal(store.restoreFromBackup(other).ok, true);
  assert.equal(store.getState().ledger.expenses.length, 0);
  assert.equal(store.backupMeta().canUndoRestore, true);
  const undone = store.undoRestore();
  assert.equal(undone.ok, true);
  assert.deepEqual(clone(store.getState()), before);
  assert.equal(store.backupMeta().canUndoRestore, false);
  // 重置演示数据前也会自动留快照
  store.reset();
  assert.equal(store.getState().ledger.expenses.length, 0);
  assert.equal(store.backupMeta().canUndoRestore, true);
  assert.equal(store.undoRestore().ok, true);
});

test('我的页：备份走发送文件，恢复先预览再确认', () => {
  const calls = seedLedger();
  const page = mount('../miniprogram/pages/me/index.js');
  page.onLoad();
  page.backupNow();
  assert.equal(calls.shared.length, 1, '备份主出口是发送文件，换机才拿得到');
  assert.match(calls.shared[0], /^55kuai2-backup-\d{8}-\d{6}\.json$/);
  assert.match(page.data.backupView.lastBackupText, /^上次备份 \d{2}-\d{2} \d{2}:\d{2}$/);

  const text = backup.createBackupText(store.getState());
  page.applyBackupText('{坏的');
  assert.equal(calls.modal[calls.modal.length - 1].title, '备份不可用');
  assert.equal(calls.modal.length, 1);

  page.applyBackupText(text);
  const confirm = calls.modal[calls.modal.length - 1];
  assert.equal(confirm.title, '整体替换当前账本');
  assert.match(confirm.content, /当前：支出 \d+ 笔/);
  assert.match(confirm.content, /备份：支出 \d+ 笔/);
  assert.match(confirm.content, /一键撤销|可.*撤销/);
  assert.equal(store.getState().ledger.expenses.length > 0, true);
  page.restoreFromFile();
  assert.equal(calls.chosen, 1);
});

test('我的页：文件与剪贴板两条恢复入口都要过校验和确认', () => {
  installWx();
  buildLedger();
  const text = backup.createBackupText(store.getState());

  // 文件入口：chooseMessageFile -> readFile -> 校验 -> 确认弹窗 -> 整体替换
  const calls = installWx({ fileText: text });
  buildLedger();
  const page = mount('../miniprogram/pages/me/index.js');
  page.onLoad();
  page.restoreFromFile();
  assert.equal(calls.chosen, 1);
  assert.match(calls.modal[0].title, /整体替换当前账本/);
  assert.match(calls.modal[0].content, /当前：支出 1 笔/);
  assert.equal(store.undoRestore().ok, true, '确认后已恢复，因此可以撤销');

  // 空内容/坏内容只提示，不弹窗替换
  const broken = installWx({ fileText: '{坏的' });
  buildLedger();
  const brokenPage = mount('../miniprogram/pages/me/index.js');
  brokenPage.onLoad();
  brokenPage.restoreFromFile();
  assert.match(broken.modal[0].title, /备份不可用/);
  assert.equal(broken.modal[0].content.includes('JSON'), true);

  // 剪贴板入口
  const clip = installWx({ clipboardText: text });
  buildLedger();
  const clipPage = mount('../miniprogram/pages/me/index.js');
  clipPage.onLoad();
  clipPage.restoreFromClipboard();
  assert.match(clip.modal[0].title, /整体替换当前账本/);
  assert.equal(store.getState().ledger.expenses.length > 0, true);

  // 取消确认就不动账本
  const cancel = installWx({ clipboardText: '{坏', modalCancel: true });
  buildLedger();
  const cancelPage = mount('../miniprogram/pages/me/index.js');
  cancelPage.onLoad();
  const before = JSON.stringify(store.getState());
  cancelPage.restoreFromClipboard();
  assert.match(cancel.modal[0].title, /备份不可用/);
  assert.equal(JSON.stringify(store.getState()), before);
});

