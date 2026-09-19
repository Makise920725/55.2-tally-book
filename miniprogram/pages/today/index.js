const { CONFIG, daysUntil, isPlanStarted, isPlanEnded, isPlanActive } = require('../../domain/plan');
const { todayKey } = require('../../domain/calendar');
const { formatFen } = require('../../domain/money');
const { dailySpent, remainingDailyBudget } = require('../../domain/ledger');
const store = require('../../store/store');

Page({
  data: { dailyBudget: formatFen(CONFIG.dailyBudget), remaining: formatFen(CONFIG.dailyBudget), deadline: CONFIG.deadline, amount: '', keypadAmount: '0', selectedCategory: 'meal', selectedCategoryName: '吃饭', categories: [], entries: [], keyRows: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'delete'], keyboardVisible: false, closed: false, started: false, ended: false, active: false, daysToStart: 0, persisted: true },
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
    const names = {}; state.categories.forEach(item => { names[item.id] = item.name; });
    const entries = state.ledger.expenses.filter(item => item.date === today).slice().reverse().map(item => ({ ...item, categoryName: names[item.category] || item.category, amountText: formatFen(item.amount) }));
    const left = remainingDailyBudget(state.ledger.expenses, today, state.config.dailyBudget);
    this.setData({ dailyBudget: formatFen(state.config.dailyBudget), remaining: formatFen(left), deadline: state.config.deadline, categories: state.categories, entries, closed: !!(state.daySlots[today] && state.daySlots[today].closed), started, ended, active, daysToStart: Math.max(0, daysUntil(state.config.startDate)) });
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
    const amount = Number(this.data.keypadAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' });
      return;
    }
    const result = store.addExpense({ date: todayKey(), category: this.data.selectedCategory, amountYuan: amount });
    if (result.blocked) {
      this.setData({ keyboardVisible: false });
      const title = result.blocked === 'closed' ? '今天已封账，可先撤销封账' : (result.blocked === 'ended' ? '计划已经结束' : '计划尚未开始');
      wx.showToast({ title, icon: 'none' });
      return;
    }
    this.setData({ amount: '', keypadAmount: '0', keyboardVisible: false, persisted: result.persisted });
    const left = remainingDailyBudget(result.state.ledger.expenses, todayKey(), result.state.config.dailyBudget);
    wx.showToast({ title: left < 0 ? `已记一笔，补差 ¥${formatFen(-left)}` : '已记一笔', icon: 'none' });
  },
  settleDay() {
    if (!this.data.active) { wx.showToast({ title: this.data.ended ? `计划已于 ${CONFIG.deadline} 结束` : `计划将于 ${CONFIG.startDate} 开始`, icon: 'none' }); return; }
    // 不传 dailyBudget，让 store 用当前情景的每日额度兜底，避免“省/松”情景退错钱。
    const result = store.settleDay({ date: todayKey() });
    wx.showToast({ title: result.batchPending ? `三天一结，请在 ${result.settlementDate} 结算` : (result.alreadyClosed ? '今天已经封账' : (result.transfer ? `已退回 ¥${formatFen(result.transfer.amount)}` : '今天没有可退余额')), icon: 'none' });
  },
  allocateDay() {
    if (!this.data.active) { wx.showToast({ title: this.data.ended ? `计划已于 ${CONFIG.deadline} 结束` : `计划将于 ${CONFIG.startDate} 开始`, icon: 'none' }); return; }
    const result = store.allocateDay({ date: todayKey() });
    const title = result.blocked === 'closed' ? '今天已封账，请先撤销封账'
      : result.blocked === 'ended' ? '计划已经结束'
      : result.blocked ? `计划将于 ${CONFIG.startDate} 开始`
      : result.skipped ? '今天不是三天结算日'
      : result.alreadyAllocated ? '今天已经划额'
      : `已划入 ¥${formatFen(result.transfer.amount)}`;
    wx.showToast({ title, icon: 'none' });
  },
  reopenDay() {
    const result = store.reopenDay(todayKey());
    wx.showToast({ title: result.reversedRefund ? `已撤销封账，退回的 ¥${formatFen(result.reversedRefund)} 也已撤销` : '已撤销封账', icon: 'none' });
  }
});
