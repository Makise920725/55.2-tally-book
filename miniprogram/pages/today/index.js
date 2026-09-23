const { CONFIG, daysUntil, isPlanStarted, isPlanEnded, isPlanActive } = require('../../domain/plan');
const { todayKey } = require('../../domain/calendar');
const { ACCT, remainingDailyBudget } = require('../../domain/ledger');
const { buildLedgerEvents, summarizeEvents } = require('../../domain/ledger-view');
const { formatFen } = require('../../domain/money');
const store = require('../../store/store');
const write = require('../../utils/write');

// 写入口的拒绝原因统一翻译成人话；store 是唯一裁决者，页面只负责说清楚。
const BLOCKED_TEXT = {
  closed: '今天已封账，可先撤销封账',
  ended: '计划已结束，账本转为只读',
  not_started: '计划还没开始',
  bad_amount: '金额要填数字，最多两位小数',
  not_allocated: '本批次还没有划额，先点上面的早间划额'
};

Page({
  data: { dailyBudget: formatFen(CONFIG.dailyBudget), remaining: formatFen(CONFIG.dailyBudget), deadline: CONFIG.deadline, amount: '', keypadAmount: '0', selectedCategory: 'meal', selectedCategoryName: '吃饭', categories: [], entries: [], summary: null, keyRows: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'delete'], keyboardVisible: false, closed: false, started: false, ended: false, active: false, daysToStart: 0, saveError: '' },
  onLoad() {
    this.unsubscribe = store.subscribe(() => this.refresh());
    this.refresh();
  },
  // 小程序切后台/跨天时重新进入必须重算“今天”，否则会继续显示昨天的额度与封账状态。
  onShow() { this.refresh(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    const today = todayKey();
    const started = isPlanStarted(today, state.config.startDate);
    const ended = isPlanEnded(today, state.config.deadline);
    const active = isPlanActive(today, state.config.startDate, state.config.deadline);
    // 统一流水投影：额度划入 / 超支补差 / 日结退款必须和普通支出同等可见（视角是工资卡），
    // 但“今天还能花”仍然只看普通支出，划转金额不参与消费计算。
    const entries = buildLedgerEvents(state, { startDate: today, endDate: today, perspective: ACCT.BANK1 });
    const totals = summarizeEvents(entries);
    const summary = {
      expense: formatFen(totals.expenseFen), transferIn: formatFen(totals.byKind.daily_alloc || 0),
      cover: formatFen(totals.byKind.overspend_cover || 0), refund: formatFen(totals.byKind.daily_refund || 0),
      special: formatFen(totals.specialFen),
      // 校准是差额，可正可负；0 时整枚 chip 隐藏。
      adjust: totals.adjustFen ? `${totals.adjustFen < 0 ? '−' : '+'}¥${formatFen(Math.abs(totals.adjustFen))}` : '',
      count: totals.count
    };
    const left = remainingDailyBudget(state.ledger.expenses, today, state.config.dailyBudget);
    this.setData({ dailyBudget: formatFen(state.config.dailyBudget), remaining: formatFen(left), deadline: state.config.deadline, categories: state.categories, entries, summary, closed: !!(state.daySlots[today] && state.daySlots[today].closed), started, ended, active, daysToStart: Math.max(0, daysUntil(state.config.startDate)) });
  },
  selectCategory(event) { this.setData({ selectedCategory: event.currentTarget.dataset.category, selectedCategoryName: event.currentTarget.dataset.name, keyboardVisible: true }); },
  openKeyboard() { this.setData({ keyboardVisible: true }); },
  noop() {},
  inputAmount(event) { this.setData({ amount: event.detail.value, keypadAmount: event.detail.value || '0' }); },
  keypress(event) {
    const key = event.currentTarget.dataset.key;
    let value = this.data.keypadAmount === '0' ? '' : this.data.keypadAmount;
    if (key === 'delete') value = value.slice(0, -1) || '0';
    else if (key === '.') { if (value.indexOf('.') < 0) value += '.'; }
    else if (value.length < 8) value += key;
    this.setData({ keypadAmount: value, amount: value === '0' ? '' : value });
  },
  closeKeyboard() { this.setData({ keyboardVisible: false }); },
  addExpense() {
    if (!this.data.active) { wx.showToast({ title: this.data.ended ? `计划已于 ${CONFIG.deadline} 结束` : `计划将于 ${CONFIG.startDate} 开始`, icon: 'none' }); return; }
    const raw = String(this.data.keypadAmount || '').trim();
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' });
      return;
    }
    const result = store.addExpense({ date: todayKey(), category: this.data.selectedCategory, amountYuan: raw });
    if (result.blocked) {
      this.setData({ keyboardVisible: false });
      write.notifyBlocked(result, BLOCKED_TEXT, '现在不能记这笔');
      return;
    }
    // 只有真的落盘才清空输入、才说「已记一笔」：存储写失败时内存状态没变，原样留着让用户重试。
    // 补差金额取 store 回传的真实值：批次额度以当天实际划入为准，改过预算情景也不会报错数字。
    const saved = write.notify(result, result.coverFen ? `已记一笔，补差 ¥${formatFen(result.coverFen)}` : '已记一笔');
    this.setData(saved ? { amount: '', keypadAmount: '0', keyboardVisible: false, saveError: '' } : { saveError: write.PERSIST_FAILED });
  },
  settleDay() {
    if (!this.data.active) { wx.showToast({ title: this.data.ended ? `计划已于 ${CONFIG.deadline} 结束` : `计划将于 ${CONFIG.startDate} 开始`, icon: 'none' }); return; }
    // 不传 dailyBudget，让 store 用当前情景的每日额度兜底，避免“省/松”情景退错钱。
    const result = store.settleDay({ date: todayKey() });
    const title = result.batchPending ? `三天一结，请在 ${result.settlementDate} 结算`
      : result.blocked ? (BLOCKED_TEXT[result.blocked] || '现在不能结算')
      : result.alreadyClosed ? '今天已经封账'
      : result.transfer ? `已退回 ¥${formatFen(result.transfer.amount)}`
      : '本批次已退完，没有可退余额';
    this.setSaveError(result);
    write.notify(result, title);
  },
  allocateDay() {
    if (!this.data.active) { wx.showToast({ title: this.data.ended ? `计划已于 ${CONFIG.deadline} 结束` : `计划将于 ${CONFIG.startDate} 开始`, icon: 'none' }); return; }
    const result = store.allocateDay({ date: todayKey() });
    const short = date => String(date).slice(5);
    const title = result.blocked ? (BLOCKED_TEXT[result.blocked] || '现在不能划额')
      : result.alreadyAllocated ? `本批次已于 ${short(result.allocationDate)} 划入`
      : result.catchUp ? `已补划 ¥${formatFen(result.transfer.amount)}（${result.spanDays} 天额度，落在批次首日 ${short(result.allocationDate)}）`
      : `已划入 ¥${formatFen(result.transfer.amount)}`;
    this.setSaveError(result);
    write.notify(result, title);
  },
  openLedger() { wx.navigateTo({ url: `/pages/ledger/index?date=${todayKey()}&range=day` }); },
  reopenDay() {
    const result = store.reopenDay(todayKey());
    this.setSaveError(result);
    write.notify(result, result.reversedRefund ? `已撤销封账，退回的 ¥${formatFen(result.reversedRefund)} 也已撤销` : '已撤销封账');
  },
  // 存储写失败是全局状态：横幅留在页面上，直到下一次写入成功才消失。
  setSaveError(result) { this.setData({ saveError: write.persistFailed(result) ? write.PERSIST_FAILED : '' }); },
});
