const test = require('node:test');
const assert = require('node:assert/strict');
const RealDate = Date; // 冻结时间后仍要能量真实耗时，这里保留原始 Date 引用。
const path = require('node:path');
const store = require('../miniprogram/store/store');
const { ACCT } = require('../miniprogram/domain/ledger');

// ---- 测试脚手架：把 Page({}) 的选项装配成可直接调用的视图模型 ----
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

function useWx(handlers = {}) {
  const calls = { toast: [], navigate: [], clipboard: [], opened: [], shared: [], written: [], modal: [] };
  global.wx = {
    getStorageSync: () => null,
    setStorageSync: (arg) => { if (typeof arg === 'object') calls.written.push(arg.key); },
    removeStorageSync: () => {},
    showToast: options => calls.toast.push(options.title),
    showModal: options => {
      calls.modal.push({ title: options.title, content: options.content });
      if (options.success) options.success({ confirm: !handlers.modalCancel });
    },
    navigateTo: options => { calls.navigate.push(options.url); if (options.success) options.success({}); },
    setClipboardData: options => { calls.clipboard.push(options.data); if (options.success) options.success({}); },
    openDocument: options => {
      calls.opened.push(options);
      if (handlers.openDocumentFails && options.fail) options.fail({ errMsg: 'openDocument:fail' });
      else if (options.success) options.success({});
    },
    shareFileMessage: options => { calls.shared.push(options); if (options.success) options.success({}); },
    env: { USER_DATA_PATH: '/tmp/tally-test' },
    getFileSystemManager: () => ({ writeFileSync: (file, content) => calls.written.push({ file, content }) })
  };
  return calls;
}

// 页面用 todayKey() 决定“今天”，测试里冻结本地时间，避免依赖真实日期。
function freezeNow(handler, at = [2026, 8, 24, 10, 30, 0]) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(...at); }
    static now() { return new RealDate(...at).getTime(); }
  }
  global.Date = FakeDate;
  try { return handler(); } finally { global.Date = RealDate; }
}

const DAY = '2026-09-24';

function runFullDay() {
  useWx();
  store.reset();
  store.allocateDay({ date: DAY });
  store.addExpense({ date: DAY, category: 'meal', amountYuan: 12 });
  store.addExpense({ date: DAY, category: 'daily', amountYuan: 18 });
  store.addSpecial({ date: DAY, reason: 'Q4 水电', amountYuan: 405.88 });
  store.addAdjust({ date: DAY, acct: ACCT.POCKET3, realBalanceYuan: 100, bookBalanceYuan: 120, note: '小数点看错' });
  store.executePayday(1, DAY);
  store.settleDay({ date: DAY });
}

test('场景一：今日页能看到当天全部账务变化，并带类型/方向/日期/时间', () => {
  freezeNow(() => {
    runFullDay();
    const page = mount('../miniprogram/pages/today/index.js');
    page.onLoad();
    const kinds = page.data.entries.map(item => item.kind);
    ['expense', 'daily_alloc', 'daily_refund', 'special', 'adjust', 'payday_income', 'bill_repay', 'payday_budget', 'payday_save'].forEach(kind => {
      assert.ok(kinds.includes(kind), `今日流水缺少 ${kind}`);
    });
    page.data.entries.forEach(item => {
      assert.equal(item.eventDate, DAY);
      assert.ok(item.typeLabel && item.title && item.flowText && item.amountText);
      assert.doesNotMatch(item.timeShort, /未记录/, `${item.kind} 应显示具体时间`);
    });
    const alloc = page.data.entries.find(item => item.kind === 'daily_alloc');
    assert.equal(alloc.amountText, '+ ¥55.19');
    assert.equal(alloc.flowText, '余额宝 → 工资卡');
    assert.deepEqual(
      { expense: page.data.summary.expense, transferIn: page.data.summary.transferIn, special: page.data.summary.special, refund: page.data.summary.refund },
      { expense: '30.00', transferIn: '55.19', special: '405.88', refund: '25.19' }
    );
    // 划转不能混进“今天还能花”
    assert.equal(page.data.remaining, '25.19');
    const nav = useWx();
    page.openLedger();
    assert.equal(nav.navigate[0], `/pages/ledger/index?date=${DAY}&range=day`);
  });
});

test('场景二：本期柱状图可点，并展开当天逐笔流水', () => {
  freezeNow(() => {
    runFullDay();
    const page = mount('../miniprogram/pages/period/index.js');
    page.onLoad();
    assert.equal(page.data.current.days, 29);
    assert.equal(page.data.current.barMinWidth, 29 * 34, '29 天需要横向滚动，保证柱子可点');
    const day = page.data.current.series.find(item => item.date === DAY);
    assert.equal(day.spent, 3000, '柱高只统计普通支出');
    assert.equal(day.expenseCount, 2);
    assert.equal(day.hasAlloc, true);
    assert.equal(day.allocAmount, 5519);
    assert.equal(day.refundAmount, 2519);
    assert.ok(day.flowCount > day.expenseCount, '柱子要能看出当天还有划转/退款');
    page.selectDay({ currentTarget: { dataset: { date: DAY } } });
    assert.equal(page.data.selectedDate, DAY);
    assert.equal(page.data.dayDetail.expenseCount, 2);
    assert.equal(page.data.dayDetail.expenseTotal, '30.00');
    assert.ok(page.data.dayDetail.expenses.every(item => item.amountText.startsWith('−')));
    const actionTitles = page.data.dayDetail.actions.map(item => item.title);
    ['日额度划入', '日结退款', '工资到账', '还账单', '预算入余额宝', '转入小荷包', 'Q4 水电', '余额校准'].forEach(title => {
      assert.ok(actionTitles.includes(title), `当天账务动作缺少 ${title}`);
    });
    const nav = useWx();
    page.openDayLedger();
    assert.equal(nav.navigate[0], `/pages/ledger/index?date=${DAY}&range=day`);
  });
});

test('场景三：储蓄页用小荷包逐笔流水解释余额，合计与派生余额一致', () => {
  freezeNow(() => {
    runFullDay();
    const page = mount('../miniprogram/pages/pocket/index.js');
    page.onLoad();
    assert.equal(page.data.pocketMatched, true);
    assert.equal(page.data.pocketNetText, page.data.pocketBalance);
    const kinds = page.data.pocketEvents.map(item => item.kind);
    assert.ok(kinds.includes('payday_save'), '要能看到发薪日转入');
    assert.ok(kinds.includes('special'), '要能看到专项支出');
    assert.ok(kinds.includes('adjust'), '要能看到校准');
    assert.ok(!kinds.includes('expense'), '工资卡普通支出不属于小荷包流水');
    assert.equal(page.data.pocketIncomeText, '1855.17');
    const save = page.data.pocketEvents.find(item => item.kind === 'payday_save');
    assert.equal(save.amountText, '+ ¥1855.17', '以小荷包视角看是流入');
    const special = page.data.pocketEvents.find(item => item.kind === 'special');
    assert.equal(special.amountText, '− ¥405.88');
    const nav = useWx();
    page.openPocketLedger();
    assert.equal(nav.navigate[0], `/pages/ledger/index?account=${ACCT.POCKET3}`);
  });
});

test('全量流水页：筛选、搜索、详情可用，写操作只有冲正', () => {
  freezeNow(() => {
    runFullDay();
    useWx();
    const page = mount('../miniprogram/pages/ledger/index.js');
    page.onLoad({ date: DAY });
    assert.equal(page.data.rangeKey, 'custom');
    assert.ok(page.data.count >= page.data.groups.reduce((total, group) => total + group.count, 0));
    assert.ok(page.data.count > 8);
    assert.equal(page.data.count, page.allEvents.length);
    page.selectType({ currentTarget: { dataset: { key: 'transfer' } } });
    page.data.groups.forEach(group => group.items.forEach(item => assert.equal(item.typeLabel, '账户划转')));
    page.selectAccount({ currentTarget: { dataset: { key: ACCT.POCKET3 } } });
    assert.ok(page.data.count > 0);
    page.selectType({ currentTarget: { dataset: { key: 'all' } } });
    const pocketOnly = page.data.groups.every(group => group.items.every(item => /小荷包/.test(item.flowText) || item.title === '余额校准'));
    assert.ok(pocketOnly, '账户筛选后不应混入无关流水');
    page.selectAccount({ currentTarget: { dataset: { key: 'all' } } });
    page.selectRange({ currentTarget: { dataset: { key: 'all' } } });
    page.inputKeyword({ detail: { value: '水电' } });
    assert.equal(page.data.count, 1);
    page.clearKeyword();
    const first = page.data.groups[0].items[0];
    page.toggleDetail({ currentTarget: { dataset: { id: first.id } } });
    const detail = page.data.groups.flatMap(group => group.items).find(item => item.id === first.id).detail;
    const labels = detail.map(row => row.label);
    ['流水 ID', '业务日期', '创建时间', '流水类型', '金额', '来源账户', '目标账户', '分类', '备注', '原始记录'].forEach(label => {
      assert.ok(labels.includes(label), `详情缺少 ${label}`);
    });
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(detail.find(row => row.label === '创建时间').value));
    page.toggleDetail({ currentTarget: { dataset: { id: first.id } } });
    const methods = Object.keys(page).filter(key => typeof page[key] === 'function').sort();
    // 唯一的写操作是 reverseExpense（追加式冲正）；不允许删除、改数或直接结算/划额。
    assert.ok(methods.includes('reverseExpense'));
    assert.deepEqual(methods.filter(name => /^(add|delete|remove|reset|edit|update|settle|allocate|reopen|execute|save)/.test(name)), []);
  });
});

test('流水页按天上拉分页，计数统计的是全量筛选结果', () => {
  freezeNow(() => {
    runFullDay();
    useWx();
    const { parseDate, dateKey } = require('../miniprogram/domain/calendar');
    const cursor = parseDate('2026-09-25');
    const end = parseDate('2026-10-22');
    while (cursor <= end) {
      store.addExpense({ date: dateKey(cursor), category: 'meal', amountYuan: 5 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const page = mount('../miniprogram/pages/ledger/index.js');
    page.onLoad({ range: 'all' });
    page.selectRange({ currentTarget: { dataset: { key: 'all' } } });
    assert.equal(page.data.groups.length, 15);
    assert.ok(page.data.moreDays > 0);
    assert.equal(page.data.count, page.allEvents.length, '合计不能被分页裁掉');
    assert.equal(page.allGroups.length, 29);
    page.onReachBottom();
    assert.ok(page.data.groups.length > 15);
  });
});

test('验收场景四：几百条流水一次导完，四类都不丢', () => {
  freezeNow(() => {
    runFullDay();
    const calls = useWx();
    const { parseDate, dateKey } = require('../miniprogram/domain/calendar');
    const cursor = parseDate('2026-09-25');
    const end = parseDate('2027-02-05');
    while (cursor <= end) {
      const date = dateKey(cursor);
      store.addExpense({ date, category: 'meal', amountYuan: 5 });
      store.addExpense({ date, category: 'snack', amountYuan: 3 });
      store.addSpecial({ date, reason: `专项 ${dateKey(cursor)}`, amountYuan: 1 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    store.addAdjust({ date: '2027-02-05', acct: ACCT.POOL2, realBalanceYuan: 1, bookBalanceYuan: 2, note: '期末校准' });
    const state = store.getState();
    const recordCount = state.ledger.expenses.length + state.ledger.transfers.length + state.ledger.specials.length + state.ledger.adjusts.length;
    const page = mount('../miniprogram/pages/me/index.js');
    page.onLoad();
    const started = RealDate.now();
    page.exportCsv();
    const elapsed = RealDate.now() - started;
    assert.ok(recordCount > 400, `样本应有 400+ 条，实际 ${recordCount}`);
    assert.equal(page.data.eventCount, recordCount);
    const written = calls.written.find(item => String(item.content).includes('流水ID'));
    const lines = String(written.content).replace('\ufeff', '').trim().split('\n');
    assert.equal(lines.length, recordCount + 1, 'CSV 行数必须等于流水数 + 表头');
    assert.ok(new Set(lines.slice(1).map(line => line.split(',')[4])).size === 4, '四类流水都要出现在导出里');
    assert.ok(elapsed < 300, `导出耗时 ${elapsed}ms`);
  });
});

test('本期日详情按净额统计，冲正不再被算成第二笔支出', () => {
  freezeNow(() => {
    runFullDay();
    useWx();
    const page = mount('../miniprogram/pages/period/index.js');
    page.onLoad();
    const target = store.getState().ledger.expenses.find(item => !item.reversalOf && item.amount === 1200);
    store.reverseExpense({ id: target.id, asOfDate: DAY });
    page.refresh();
    page.selectDay({ currentTarget: { dataset: { date: DAY } } });
    assert.equal(page.data.dayDetail.expenseCount, 1, '只有 1 笔真实支出（18 元）');
    assert.equal(page.data.dayDetail.reversalCount, 1);
    assert.equal(page.data.dayDetail.expenseTotal, '18.00', '净额 30 − 12 = 18，不能翻倍成 42 或 60');
    assert.equal(page.data.dayDetail.reversalTotal, '12.00');
    const bar = page.data.current.series.find(item => item.date === DAY);
    assert.equal(bar.spent, 1800, '柱高与净支出一致');
    const struck = page.data.dayDetail.expenses.find(item => item.id === target.id);
    assert.equal(struck.reversed, true);
    assert.ok(page.data.dayDetail.expenses.some(item => item.reversal));
  });
});

test('流水页合计文案自带符号，模板不再二次拼接 ¥', () => {
  freezeNow(() => {
    runFullDay();
    useWx();
    const page = mount('../miniprogram/pages/ledger/index.js');
    page.onLoad();
    const fs = require('node:fs');
    const template = fs.readFileSync(require.resolve('../miniprogram/pages/ledger/index.wxml'), 'utf8');
    assert.ok(!/¥\{\{summary\./.test(template), '模板里不能再出现 ¥{{summary.*}}，否则会渲染成 ¥¥0.00');
    assert.ok(!/summary\.adjustSign/.test(template));
    Object.values(page.data.summary).forEach(text => assert.match(text, /^[+−]?¥\d+\.\d{2}$/));
    assert.equal(page.data.summary.adjust, '−¥20.00');
    assert.equal(page.data.summary.expense, '¥30.00');
  });
});

test('计划区间外的校准也能用自定义日期检索到', () => {
  freezeNow(() => {
    useWx();
    store.reset();
    store.addAdjust({ date: '2026-09-19', acct: ACCT.BANK1, realBalanceYuan: 100, bookBalanceYuan: 90, note: '计划前对账' });
    store.addAdjust({ date: '2027-03-05', acct: ACCT.POOL2, realBalanceYuan: 1, bookBalanceYuan: 1, note: '计划后对账' });
    const page = mount('../miniprogram/pages/ledger/index.js');
    page.onLoad();
    assert.equal(page.data.minDate, '2026-09-19', '选择器要覆盖实际存在的流水日期');
    assert.equal(page.data.maxDate, '2027-03-05');
    page.selectRange({ currentTarget: { dataset: { key: 'custom' } } });
    page.selectStart({ detail: { value: '2026-09-19' } });
    page.selectEnd({ detail: { value: '2026-09-19' } });
    assert.equal(page.data.count, 1);
    assert.equal(page.allEvents[0].note, '计划前对账');
    page.selectStart({ detail: { value: '2027-03-05' } });
    page.selectEnd({ detail: { value: '2027-03-05' } });
    assert.equal(page.data.count, 1);
    assert.equal(page.allEvents[0].note, '计划后对账');
  });
});

test('流水页的冲正入口：先说明连带影响，确认后才写入', () => {
  freezeNow(() => {
    runFullDay();                                 // 该批次当天已封账
    const calls = useWx();
    const page = mount('../miniprogram/pages/ledger/index.js');
    page.onLoad({ date: DAY });
    const target = page.allEvents.find(item => item.type === 'expense' && item.amountFen === 1200);
    page.toggleDetail({ currentTarget: { dataset: { id: target.id } } });
    assert.equal(page.data.groups.flatMap(g => g.items).find(item => item.id === target.id).canReverse, true);
    page.reverseExpense({ currentTarget: { dataset: { id: target.id } } });
    assert.equal(calls.modal.length, 1);
    assert.match(calls.modal[0].content, /追加一笔 −¥12\.00 的冲正/);
    assert.match(calls.modal[0].content, /批次已封账，今天要从工资卡补退 ¥12\.00/);
    const reversal = store.getState().ledger.expenses.find(item => item.reversalOf === target.id);
    assert.ok(reversal, '确认后应追加冲正记录');
    assert.equal(reversal.amount, -1200);
    page.toggleDetail({ currentTarget: { dataset: { id: target.id } } });
    page.reverseExpense({ currentTarget: { dataset: { id: target.id } } });
    assert.equal(calls.modal.length, 1, '重复冲正只提示，不再弹确认');
    assert.match(calls.toast[calls.toast.length - 1], /已经.*冲正/);
    assert.equal(page.data.groups.flatMap(g => g.items).find(item => item.id === target.id).canReverse, false);
  });
});

test('未封账批次的冲正提示是“结算时重算”，不产生补退', () => {
  freezeNow(() => {
    useWx();
    store.reset();
    store.allocateDay({ date: DAY });
    store.addExpense({ date: DAY, category: 'meal', amountYuan: 20 });
    const calls = useWx();
    const page = mount('../miniprogram/pages/ledger/index.js');
    page.onLoad({ date: DAY });
    const target = page.allEvents.find(item => item.type === 'expense');
    page.reverseExpense({ currentTarget: { dataset: { id: target.id } } });
    assert.match(calls.modal[0].content, /还没封账，结算时会按修正后的净支出重算/);
    assert.equal(store.getState().ledger.transfers.filter(item => item.kind === 'daily_refund').length, 0);
  });
});

test('隐藏冲正对只影响列表，不影响余额自检', () => {
  freezeNow(() => {
    runFullDay();
    useWx();
    const page = mount('../miniprogram/pages/ledger/index.js');
    page.onLoad({ date: DAY });
    const target = page.allEvents.find(item => item.type === 'expense' && !item.reversalOf);
    store.reverseExpense({ id: target.id, asOfDate: DAY });
    page.refresh();
    const shown = page.allEvents.length;
    page.toggleHideReversals();
    assert.equal(page.data.hideReversals, true);
    assert.ok(page.allEvents.length < shown, '冲正对与补退都应隐藏');
    assert.ok(!page.allEvents.some(item => item.reversalOf || item.reversed || item.trueUp));
    page.toggleHideReversals();
    assert.equal(page.allEvents.length, shown);
  });
});

test('批量冲正 UI：勾选多笔，一次确认全部写入', () => {
  freezeNow(() => {
    runFullDay();                                 // 当天已封账，冲正会产生补退
    const calls = useWx();
    const page = mount('../miniprogram/pages/ledger/index.js');
    page.onLoad({ date: DAY });
    page.toggleBatchMode();
    assert.equal(page.data.selectionMode, true);
    // 可冲正的是两笔支出 + 一笔专项（划转与校准不给入口）
    const reversible = page.allEvents.filter(item => item.reversible).map(item => item.id);
    assert.deepEqual(page.allEvents.filter(item => item.reversible).map(item => item.type).sort(), ['expense', 'expense', 'special']);
    reversible.forEach(id => page.toggleSelect({ currentTarget: { dataset: { id } } }));
    assert.equal(page.data.selectedCount, 3);
    assert.equal(page.data.batchSummary.count, 3);
    assert.equal(page.data.batchSummary.amount, '435.88');
    assert.match(page.data.batchSummary.hint, /已封账[\s\S]*补退 ¥30\.00/);
    const rows = page.data.groups.flatMap(group => group.items);
    assert.equal(rows.filter(item => item.checked).length, 3);
    page.confirmBatch();
    assert.match(calls.modal[0].title, /冲正 3 笔流水/);
    const state = store.getState();
    assert.equal(state.ledger.expenses.filter(item => item.reversalOf).length, 2);
    assert.equal(state.ledger.specials.filter(item => item.reversalOf).length, 1);
    // 每笔冲正各带一条补退，钱和冲正一一对应，流水里可追溯
    assert.equal(state.ledger.transfers.filter(item => item.trueUp).length, 2);
    assert.equal(state.ledger.transfers.filter(item => item.trueUp).reduce((total, item) => total + item.amount, 0), 3000);
    assert.equal(page.data.selectionMode, false);
    assert.equal(page.data.selectedCount, 0);
  });
});

test('批量模式只让可冲正的行被选中', () => {
  freezeNow(() => {
    runFullDay();
    const calls = useWx();
    const page = mount('../miniprogram/pages/ledger/index.js');
    page.onLoad({ date: DAY });
    page.toggleBatchMode();
    const transfer = page.allEvents.find(item => item.type === 'transfer');
    page.toggleSelect({ currentTarget: { dataset: { id: transfer.id } } });
    assert.equal(page.data.selectedCount, 0);
    assert.equal(calls.toast[calls.toast.length - 1], '这笔记录不能冲正');
    // 已经全部冲正过的行也不再可选
    const target = page.allEvents.find(item => item.reversible);
    page.toggleSelect({ currentTarget: { dataset: { id: target.id } } });
    page.confirmBatch();
    const fullyReversed = store.getState().ledger.expenses.find(item => !item.reversalOf && item.amount === 1200);
    page.toggleSelect({ currentTarget: { dataset: { id: fullyReversed.id } } });
    assert.equal(page.data.selectedCount, 1);
  });
});

test('部分冲正 UI：输入金额只冲一部分，剩余可冲额随之更新', () => {
  freezeNow(() => {
    useWx();
    store.reset();
    store.allocateDay({ date: DAY });
    store.addExpense({ date: DAY, category: 'meal', amountYuan: 12 });
    const calls = useWx();
    const page = mount('../miniprogram/pages/ledger/index.js');
    page.onLoad({ date: DAY });
    const row = page.allEvents.find(item => item.reversible);
    page.toggleDetail({ currentTarget: { dataset: { id: row.id } } });
    page.inputPartial({ detail: { value: '5' } });
    page.reversePartial({ currentTarget: { dataset: { id: row.id, source: 'expenses', remaining: '12.00' } } });
    assert.match(calls.modal[0].content, /追加一笔 −¥5\.00 的冲正/);
    assert.match(calls.modal[0].content, /还剩下 ¥7\.00 有效/);
    const after = store.getState().ledger.expenses.find(item => item.reversalOf);
    assert.equal(after.amount, -500);
    page.refresh();
    const updated = page.allEvents.find(item => item.id === row.id);
    assert.equal(updated.remainingFen, 700);
    assert.equal(updated.reversed, true);
    assert.equal(updated.reversedFully, false);
    page.inputPartial({ detail: { value: '9' } });
    const before = calls.modal.length;
    page.reversePartial({ currentTarget: { dataset: { id: row.id, source: 'expenses', remaining: '7.00' } } });
    assert.equal(calls.modal.length, before, '超过剩余可冲额直接提示，不弹确认');
    assert.equal(calls.toast[calls.toast.length - 1], '最多还能冲 ¥7.00');
  });
});

test('CSV 导出走文件通道，剪贴板只在兜底时使用', () => {
  freezeNow(() => {
    runFullDay();
    const calls = useWx();
    const page = mount('../miniprogram/pages/me/index.js');
    page.onLoad();
    page.exportCsv();
    assert.equal(calls.opened.length, 1, '应优先 wx.openDocument');
    assert.match(calls.opened[0].filePath, /^\/tmp\/tally-test\/55kuai2-ledger-\d{8}-\d{6}\.csv$/);
    assert.equal(calls.clipboard.length, 0, '主出口不能再是剪贴板');
    const failing = useWx({ openDocumentFails: true });
    page.exportCsv();
    assert.equal(failing.shared.length, 1, 'openDocument 失败时先尝试发送文件');
    assert.ok(failing.written.some(item => String(item.content).includes('流水ID')));
    assert.ok(failing.written.find(item => String(item.content).includes('流水ID')).file.endsWith('.csv'));
  });
});


test('本期页预算池显示真实入池额，不是固定的计划值', () => {
  // 今天 = 2026-09-25：工资已登记（只入池 1,455.68），生活费还没到（计划池额 1,600.51）
  freezeNow(() => {
    useWx();
    store.reset();
    store.registerSalaryDay(1, '2026-09-24');
    const page = mount('../miniprogram/pages/period/index.js');
    page.onLoad();
    assert.equal(page.data.current.budget, '1455.68', '修复前这里恒显示计划值 1600.51，看着像钱已经到位');
    assert.equal(page.data.current.budgetPlan, '1600.51');
    assert.equal(page.data.current.budgetFull, false, '没到齐时要显示成「实际 / 计划」');
    assert.equal(page.data.current.budgetPending, '144.83', '还差多少要写出来，等生活费补');
    // 用户自选少放余额宝时，这里必须跟着真实流水走
    store.registerAllowance(1, { date: '2026-09-25', asOfDate: '2026-09-25', split: { billYuan: '0', poolYuan: '0', saveYuan: '2000' } });
    page.refresh();
    assert.equal(page.data.current.budget, '1455.68', '生活费全存了小荷包，池子就还是 1,455.68');
    assert.equal(page.data.current.budgetFull, true, '两笔到齐后目标 = 流水事实，不再显示「/ 计划」');
    assert.equal(page.data.current.budgetPending, '');
    page.onUnload();
  }, [2026, 8, 25, 10, 0, 0]);
});

test('本期页能给历史上漏划额的那天补划，并接着结算闭环；未来的日子只提示不写账', () => {
  // 今天 = 2026-09-27：09-25 是“过去的某天”，09-30 还没到
  freezeNow(() => {
    const { accountBalances } = require('../miniprogram/domain/ledger');
    const calls = useWx();
    store.reset();
    store.executePayday(1, '2026-09-24');
    store.addExpense({ date: '2026-09-25', category: 'meal', amountYuan: 30 });   // 当天只记支出，没点早间划额
    const page = mount('../miniprogram/pages/period/index.js');
    page.onLoad();
    page.selectDay({ currentTarget: { dataset: { date: '2026-09-25' } } });
    assert.equal(page.data.dayDetail.canAllocate, true);
    assert.match(page.data.dayDetail.allocateText, /补划这天额度 ¥55\.19/);
    assert.equal(page.data.dayDetail.canSettle, false);
    assert.equal(page.data.dayDetail.dayNotice, '这天还没划额，先补划再结算');

    page.allocateSelectedDay();
    const allocs = store.getState().ledger.transfers.filter(item => item.kind === 'daily_alloc').map(item => `${item.date}=${item.amount}`);
    assert.deepEqual(allocs, ['2026-09-25=5519'], '补划落在所选的那一天');
    assert.equal(page.data.dayDetail.canAllocate, false);
    assert.equal(page.data.dayDetail.canSettle, true);
    assert.match(page.data.dayDetail.settleText, /结算这天 · 退回余额宝 ¥25\.19/);

    page.settleSelectedDay();
    const state = store.getState();
    assert.equal(state.daySlots['2026-09-25'].closed, true);
    const balances = accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);
    assert.equal(balances.BANK1, 0, '补划 + 结算之后工资卡归零，钱不会半浮在卡上');
    assert.equal(balances.POOL2, 160051 - 5519 + 2519);
    assert.equal(page.data.dayDetail.canSettle, false);
    assert.equal(page.data.dayDetail.dayNotice, '本批次已封账；要更正请撤销封账，或走追加式冲正');
    assert.ok(calls.toast.some(title => title.includes('已退回 ¥25.19')));

    // 未来的日子不给写账入口
    page.selectDay({ currentTarget: { dataset: { date: '2026-09-30' } } });
    assert.equal(page.data.dayDetail.canAllocate, false);
    assert.equal(page.data.dayDetail.canSettle, false);
    assert.equal(page.data.dayDetail.dayNotice, '这天还没到，先把当天的账记实');
  }, [2026, 8, 27, 9, 0, 0]);
});

test('场景五：第五步「清理余粮」在发薪日页与储蓄页都必须先确认再写账', () => {
  // 今天 = 2026-09-25；09-24 已经走完一天，没花完的 35.19 退回余额宝
  freezeNow(() => {
    const { accountBalances } = require('../miniprogram/domain/ledger');
    const balancesOf = () => {
      const state = store.getState();
      return accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);
    };
    const carryCount = () => store.getState().ledger.transfers.filter(item => item.kind === 'carry_over').length;
    useWx();
    store.reset();
    store.executePayday(1, DAY);
    store.allocateDay({ date: DAY });
    store.addExpense({ date: DAY, category: 'meal', amountYuan: 20 });
    store.settleDay({ date: DAY });

    const payday = mount('../miniprogram/pages/payday/index.js');
    payday.onLoad();
    assert.equal(payday.data.canSweep, true);
    assert.match(payday.data.steps[5].flowText, /当前可清理 ¥35\.19/);
    assert.match(payday.data.sweepText, /清理余额宝余粮 ¥35\.19 → 小荷包/);

    // 先点「先不转」：一个字都不该写
    useWx({ modalCancel: true });
    payday.sweepSurplus();
    assert.equal(carryCount(), 0, '没确认就不能搬钱');

    // 再确认：写入一笔 carry_over，钱只是从余额宝搬到小荷包
    const before = balancesOf();
    const calls = useWx();
    payday.sweepSurplus();
    assert.equal(calls.modal.length, 1);
    assert.match(calls.modal[0].content, /把多出来的 ¥35\.19 转进小荷包/);
    assert.equal(carryCount(), 1);
    assert.deepEqual(store.getState().ledger.transfers.filter(item => item.kind === 'carry_over').map(item => `${item.date}=${item.amount}`), ['2026-09-25=3519']);
    assert.ok(calls.toast.some(title => title.includes('已转入小荷包 ¥35.19')));
    const after = balancesOf();
    assert.equal(after.POOL2, before.POOL2 - 3519);
    assert.equal(after.POCKET3, before.POCKET3 + 3519);
    assert.equal(after.POOL2 + after.POCKET3, before.POOL2 + before.POCKET3, '清理只是搬钱，不创造钱');

    const pocket = mount('../miniprogram/pages/pocket/index.js');
    pocket.onLoad();
    assert.equal(pocket.data.surplusCard, null, '刚清理完就不该再劝用户转钱');
    assert.match(pocket.data.periods[0].sweptText, /含清理转入 ¥35\.19/);

    // 再过完 09-25 这一天：封账后今天的额度变成熟余粮，储蓄页重新出现卡片
    store.allocateDay({ date: '2026-09-25' });
    store.addExpense({ date: '2026-09-25', category: 'snack', amountYuan: 10 });
    store.settleDay({ date: '2026-09-25' });
    pocket.refresh();
    assert.equal(pocket.data.surplusCard.amountText, '45.19');
    pocket.sweepSurplus();
    assert.equal(carryCount(), 2);
  }, [2026, 8, 25, 9, 0, 0]);
});
