const { todayKey } = require('../../domain/calendar');
const { formatFen } = require('../../domain/money');
const { ACCT } = require('../../domain/ledger');
const { buildLedgerEvents, summarizeEvents, groupEventsByDate, accountLabel } = require('../../domain/ledger-view');
const { periodForDate } = require('../../domain/plan');
const store = require('../../store/store');

const RANGE_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今日' },
  { key: 'period', label: '本期' },
  { key: 'custom', label: '自定义' }
];
const TYPE_OPTIONS = [
  { key: 'all', label: '全部', types: null },
  { key: 'expense', label: '支出', types: ['expense'] },
  { key: 'transfer', label: '账户划转', types: ['transfer'] },
  { key: 'special', label: '专项', types: ['special'] },
  { key: 'adjust', label: '校准', types: ['adjust'] }
];
const GROUP_PAGE = 15; // 一屏 15 天的流水，上拉继续加载，避免一次性 setData 上千个节点。

// 冲正是这个页面唯一的写操作：原记录不动，只追加负向流水（以及已封账批次的补退）。
const REVERSE_BLOCKED_TEXT = {
  not_found: '找不到这笔记录',
  is_reversal: '冲正记录本身不能再冲正',
  already_reversed: '这笔记录已经全部冲正过了',
  bad_amount: '冲正金额不合法（不能超过剩余可冲额）',
  ended: '计划已结束，账本转为只读',
  not_started: '计划尚未开始'
};
// 可冲正的记录类型 -> store 里的来源数组。划转是真实转账、校准本身就是追加差额，都不给冲正入口。
const REVERSIBLE_SOURCES = Object.freeze({ expense: 'expenses', special: 'specials' });

const ACCOUNT_OPTIONS = [
  { key: 'all', label: '全部账户', account: null },
  { key: ACCT.BANK1, label: '工资卡', account: ACCT.BANK1 },
  { key: ACCT.POOL2, label: '余额宝', account: ACCT.POOL2 },
  { key: ACCT.POCKET3, label: '小荷包', account: ACCT.POCKET3 },
  { key: ACCT.BILL, label: '账单', account: ACCT.BILL },
  { key: ACCT.OUT, label: '支出', account: ACCT.OUT }
];

// 流水页是只读视图：不做删除和修改，避免破坏超支补差、日结退款和三日批次不变量。
function detailRows(event) {
  return [
    { label: '流水 ID', value: event.id },
    { label: '业务日期', value: event.eventDate },
    { label: '创建时间', value: event.exactTime ? event.timeText : '时间未记录' },
    { label: '流水类型', value: `${event.typeLabel}　${event.kind && event.kind !== event.type ? event.kindLabel : ''}`.trim() },
    { label: '金额', value: `${event.amountText}　（${event.direction}）` },
    { label: '来源账户', value: event.type === 'adjust' ? '—' : accountLabel(event.from, 'from') },
    { label: '目标账户', value: event.type === 'adjust' ? '—' : accountLabel(event.to, 'to') },
    { label: '分类', value: event.categoryName || '—' },
    { label: '备注', value: event.note || '—' },
    { label: '冲正状态', value: event.reversalOf ? `冲正 ${event.reversalOf}`
        : (event.reversed ? `已冲正 ¥${formatFen(event.reversedFen)}，还剩 ¥${formatFen(event.remainingFen)} 可冲` : '正常记录') },
    { label: '剩余可冲额', value: event.reversalOf || event.type === 'transfer' || event.type === 'adjust' ? '—' : `¥${formatFen(event.remainingFen)}` },
    { label: '原始记录', value: `${event.source}${event.kind ? ` · ${event.kind}` : ''}${event.batchKey ? ` · 归属批次 ${event.batchKey}` : ''}` }
  ];
}

// 计划区间外的流水（例如余额校准不受计划日期限制）也必须能被自定义日期检索到，
// 所以选择器边界取“计划区间 ∪ 实际流水日期”。
function ledgerDateBounds(state) {
  const dates = ['expenses', 'transfers', 'specials', 'adjusts']
    .reduce((all, key) => all.concat((state.ledger[key] || []).map(item => item.date)), [])
    .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date || ''));
  const first = dates.length ? dates.reduce((min, date) => (date < min ? date : min)) : state.config.startDate;
  const last = dates.length ? dates.reduce((max, date) => (date > max ? date : max)) : state.config.deadline;
  return {
    minDate: first < state.config.startDate ? first : state.config.startDate,
    maxDate: last > state.config.deadline ? last : state.config.deadline
  };
}

Page({
  data: {
    ranges: RANGE_OPTIONS, types: TYPE_OPTIONS, accounts: ACCOUNT_OPTIONS,
    rangeKey: 'all', typeKey: 'all', accountKey: 'all', keyword: '', hideReversals: false,
    startDate: '', endDate: '', minDate: '', maxDate: '',
    selected: {}, selectedCount: 0, selectionMode: false, batchSummary: null, partialAmount: '',
    groups: [], count: 0, summary: { expense: '¥0.00', transfer: '¥0.00', special: '¥0.00', adjust: '¥0.00' }, detailId: '', empty: false, groupLimit: GROUP_PAGE, moreDays: 0
  },
  onLoad(query = {}) {
    this.detailCache = {};
    this.allEvents = [];
    this.allGroups = [];
    const state = store.getState();
    const today = todayKey();
    const next = ledgerDateBounds(state);
    if (query.date) {
      next.rangeKey = 'custom';
      next.startDate = query.date;
      next.endDate = query.date;
    }
    if (query.startDate && query.endDate) {
      next.rangeKey = query.range === 'period' ? 'period' : 'custom';
      next.startDate = query.startDate;
      next.endDate = query.endDate;
    }
    if (query.account && ACCOUNT_OPTIONS.some(item => item.key === query.account)) next.accountKey = query.account;
    if (query.type && TYPE_OPTIONS.some(item => item.key === query.type)) next.typeKey = query.type;
    this.setData(next);
    this.unsubscribe = store.subscribe(() => this.refresh());
    this.refresh();
  },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  currentRange() {
    const today = todayKey();
    if (this.data.rangeKey === 'today') return { startDate: today, endDate: today };
    if (this.data.rangeKey === 'period') {
      const period = periodForDate(today, store.getState().periods);
      return period ? { startDate: period.rangeStart, endDate: period.rangeEnd } : { startDate: today, endDate: today };
    }
    if (this.data.rangeKey === 'custom') {
      const startDate = this.data.startDate || today;
      const endDate = this.data.endDate || startDate;
      return startDate <= endDate ? { startDate, endDate } : { startDate: endDate, endDate: startDate };
    }
    return {};
  },
  refresh() {
    const state = store.getState();
    this.setData(ledgerDateBounds(state));
    const range = this.currentRange();
    const type = TYPE_OPTIONS.find(item => item.key === this.data.typeKey) || TYPE_OPTIONS[0];
    const account = ACCOUNT_OPTIONS.find(item => item.key === this.data.accountKey) || ACCOUNT_OPTIONS[0];
    this.allEvents = buildLedgerEvents(state, {
      startDate: range.startDate,
      endDate: range.endDate,
      types: type.types,
      account: account.account,
      keyword: this.data.keyword,
      perspective: account.account,
      hideReversals: this.data.hideReversals
    });
    this.allGroups = groupEventsByDate(this.allEvents);
    const totals = summarizeEvents(this.allEvents);
    this.setData({
      count: totals.count,
      // 四枚合计都带完整的 ¥/符号，模板只负责显示，避免「¥−¥20.00」这类二次拼接。
      summary: {
        expense: `¥${formatFen(totals.expenseFen)}`,
        transfer: `¥${formatFen(totals.transferFen)}`,
        special: `¥${formatFen(totals.specialFen)}`,
        adjust: totals.adjustFen ? `${totals.adjustFen < 0 ? '−' : '+'}¥${formatFen(Math.abs(totals.adjustFen))}` : '¥0.00'
      },
      empty: this.allEvents.length === 0
    });
    this.applyPaging();
  },
  // 分组按可见天数分页渲染，详情挂在被点中的那一行下面。
  applyPaging() {
    const shown = this.allGroups.slice(0, this.data.groupLimit);
    this.setData({
      groups: shown.map(group => ({
        ...group,
        items: group.items.map(item => ({
          id: item.id, typeLabel: item.typeLabel, title: item.title, flowText: item.flowText,
          amountText: item.amountText, timeShort: item.timeShort, eventDate: item.eventDate,
          note: item.note, signedFen: item.signedFen, exactTime: item.exactTime,
          reversal: item.reversal, reversed: item.reversed, reversedFully: item.reversedFully,
          remainingText: formatFen(item.remainingFen || 0),
          canReverse: Boolean(item.reversible) && Boolean(REVERSIBLE_SOURCES[item.type]),
          source: REVERSIBLE_SOURCES[item.type] || item.source,
          amountFen: Math.abs(item.amountFen),
          checked: Boolean(this.data.selected[item.id]),
          batchMode: this.data.selectionMode,
          detail: item.id === this.data.detailId ? this.detailCache[item.id] : null
        }))
      })),
      moreDays: Math.max(0, this.allGroups.length - shown.length)
    });
  },
  onReachBottom() {
    if (!this.data.moreDays) return;
    this.setData({ groupLimit: this.data.groupLimit + GROUP_PAGE }, () => this.applyPaging());
  },
  selectRange(event) {
    const key = event.currentTarget.dataset.key;
    const today = todayKey();
    const patch = { rangeKey: key, detailId: '', groupLimit: GROUP_PAGE, selectionMode: false, selected: {}, selectedCount: 0, batchSummary: null };
    if (key === 'custom' && !this.data.startDate) { patch.startDate = today; patch.endDate = today; }
    this.setData(patch, () => this.refresh());
  },
  selectType(event) { this.setData({ typeKey: event.currentTarget.dataset.key, detailId: '', groupLimit: GROUP_PAGE, selectionMode: false, selected: {}, selectedCount: 0, batchSummary: null }, () => this.refresh()); },
  selectAccount(event) { this.setData({ accountKey: event.currentTarget.dataset.key, detailId: '', groupLimit: GROUP_PAGE, selectionMode: false, selected: {}, selectedCount: 0, batchSummary: null }, () => this.refresh()); },
  inputKeyword(event) { this.setData({ keyword: event.detail.value, detailId: '', groupLimit: GROUP_PAGE }, () => this.refresh()); },
  clearKeyword() { this.setData({ keyword: '', detailId: '', groupLimit: GROUP_PAGE }, () => this.refresh()); },
  selectStart(event) { this.setData({ startDate: event.detail.value, detailId: '', groupLimit: GROUP_PAGE }, () => this.refresh()); },
  selectEnd(event) { this.setData({ endDate: event.detail.value, detailId: '', groupLimit: GROUP_PAGE }, () => this.refresh()); },
  toggleHideReversals() {
    this.setData({ hideReversals: !this.data.hideReversals, detailId: '', groupLimit: GROUP_PAGE }, () => this.refresh());
  },
  // —— 冲正：先预览连带影响（已封账批次要补退多少钱），确认后才写入 ——
  toggleBatchMode() {
    const selectionMode = !this.data.selectionMode;
    this.setData({ selectionMode, selected: {}, selectedCount: 0, batchSummary: null, detailId: '', partialAmount: '' }, () => this.applyPaging());
  },
  toggleSelect(event) {
    const id = event.currentTarget.dataset.id;
    const found = (this.allEvents || []).find(item => item.id === id);
    if (!found || !found.reversible) { wx.showToast({ title: '这笔记录不能冲正', icon: 'none' }); return; }
    const selected = { ...this.data.selected };
    if (selected[id]) delete selected[id];
    else selected[id] = { id, source: REVERSIBLE_SOURCES[found.type], title: found.title, amountText: found.amountText };
    this.setData({ selected, selectedCount: Object.keys(selected).length }, () => {
      this.applyPaging();
      this.refreshBatchSummary();
    });
  },
  batchEntries() {
    return Object.keys(this.data.selected).map(id => ({ id, source: this.data.selected[id].source }));
  },
  refreshBatchSummary() {
    const entries = this.batchEntries();
    if (!entries.length) { this.setData({ batchSummary: null }); return; }
    const result = store.previewReversal(entries, todayKey());
    if (result.blocked) { this.setData({ batchSummary: null }); wx.showToast({ title: REVERSE_BLOCKED_TEXT[result.blocked] || '暂时不能冲正', icon: 'none' }); return; }
    this.setData({ batchSummary: this.summaryText(result.summary) });
  },
  summaryText(summary) {
    return {
      count: summary.count,
      amount: formatFen(summary.amountFen),
      trueUp: formatFen(summary.trueUpFen),
      trueUpCount: summary.trueUpCount,
      closedCount: summary.closedCount,
      hint: summary.trueUpFen
        ? `其中 ${summary.trueUpCount} 笔所在批次已封账，今天要从工资卡补退 ¥${formatFen(summary.trueUpFen)} 到余额宝。`
        : '这些批次还没封账，结算时会按修正后的净支出重算补差和退款。'
    };
  },
  confirmBatch() {
    const entries = this.batchEntries();
    if (!entries.length) { wx.showToast({ title: '先选择要冲正的流水', icon: 'none' }); return; }
    const preview = store.previewReversal(entries, todayKey());
    if (preview.blocked) { wx.showToast({ title: REVERSE_BLOCKED_TEXT[preview.blocked] || '暂时不能冲正', icon: 'none' }); return; }
    const text = this.summaryText(preview.summary);
    wx.showModal({
      title: `冲正 ${text.count} 笔流水`,
      content: `原记录全部保留，追加 ${text.count} 笔负向冲正，合计 ¥${text.amount}。${text.hint}`,
      confirmText: '确认冲正',
      cancelText: '先不动',
      success: result => {
        if (!result.confirm) return;
        const done = store.reverseEntries({ entries, asOfDate: todayKey() });
        if (done.blocked) { wx.showToast({ title: REVERSE_BLOCKED_TEXT[done.blocked] || '冲正失败，未改动任何流水', icon: 'none' }); return; }
        this.setData({ selectionMode: false, selected: {}, selectedCount: 0, batchSummary: null });
        wx.showToast({ title: done.summary.trueUpFen ? `已冲正 ${done.summary.count} 笔，并补退 ¥${formatFen(done.summary.trueUpFen)}` : `已冲正 ${done.summary.count} 笔`, icon: 'none' });
      }
    });
  },
  reverseExpense(event) {
    const id = event.currentTarget.dataset.id;
    const source = event.currentTarget.dataset.source || 'expenses';
    const amountText = event.currentTarget.dataset.amount;
    this.runReversal([{ id, source }], `冲正这笔 ¥${amountText}`, false);
  },
  noop() {},
  inputPartial(event) { this.setData({ partialAmount: event.detail.value }); },
  // 部分冲正：只冲 entered 的金额，剩余可冲额由 store 把关。
  reversePartial(event) {
    const id = event.currentTarget.dataset.id;
    const source = event.currentTarget.dataset.source || 'expenses';
    const remaining = event.currentTarget.dataset.remaining;
    const amount = Number(this.data.partialAmount);
    if (!Number.isFinite(amount) || amount <= 0) { wx.showToast({ title: '请输入要冲正的金额', icon: 'none' }); return; }
    if (amount > Number(remaining)) { wx.showToast({ title: `最多还能冲 ¥${remaining}`, icon: 'none' }); return; }
    this.runReversal([{ id, source, amountFen: Math.round(amount * 100) }], `冲正这笔中的 ¥${amount.toFixed(2)}`, true);
  },
  runReversal(entries, title, partial) {
    const today = todayKey();
    const preview = store.previewReversal(entries, today);
    if (preview.blocked) { wx.showToast({ title: REVERSE_BLOCKED_TEXT[preview.blocked] || '暂时不能冲正', icon: 'none' }); return; }
    const text = this.summaryText(preview.summary);
    const target = (this.allEvents || []).find(item => item.id === entries[0].id) || {};
    const line = partial
      ? `原记录保留不动，追加一笔 −¥${text.amount} 的冲正，这条还剩下 ¥${formatFen(Math.abs(target.amountFen || 0) - preview.summary.amountFen)} 有效。`
      : `原记录保留不动，追加一笔 −¥${text.amount} 的冲正（同一张单、同一个账户）。`;
    wx.showModal({
      title,
      content: `${line}${text.hint}`,
      confirmText: '确认冲正',
      cancelText: '先不动',
      success: result => {
        if (!result.confirm) return;
        const done = store.reverseEntries({ entries, asOfDate: today });
        if (done.blocked) { wx.showToast({ title: REVERSE_BLOCKED_TEXT[done.blocked] || '暂时不能冲正', icon: 'none' }); return; }
        this.setData({ partialAmount: '' });
        wx.showToast({ title: done.summary.trueUpFen ? `已冲正，并补退 ¥${formatFen(done.summary.trueUpFen)}` : '已冲正', icon: 'none' });
      }
    });
  },
  onRowTap(event) {
    if (this.data.selectionMode) { this.toggleSelect(event); return; }
    this.toggleDetail(event);
  },
  toggleDetail(event) {
    const id = event.currentTarget.dataset.id;
    if (id === this.data.detailId) { this.setData({ detailId: '' }, () => this.applyPaging()); return; }
    const found = (this.allEvents || []).find(item => item.id === id);
    if (!found) return;
    this.detailCache[id] = detailRows(found);
    this.setData({ detailId: id }, () => this.applyPaging());
  }
});
