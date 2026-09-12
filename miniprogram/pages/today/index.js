const { CONFIG } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');
const { dailySpent, remainingDailyBudget } = require('../../domain/ledger');
const store = require('../../store/store');

function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

Page({
  data: { dailyBudget: formatFen(CONFIG.dailyBudget), remaining: formatFen(CONFIG.dailyBudget), amount: '', keypadAmount: '0', selectedCategory: 'meal', selectedCategoryName: '吃饭', categories: [], entries: [], keyRows: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'delete'], keyboardVisible: false, closed: false, persisted: true },
  onLoad() {
    this.unsubscribe = store.subscribe(() => this.refresh());
    this.refresh();
  },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    const today = dateKey();
    const names = {}; state.categories.forEach(item => { names[item.id] = item.name; });
    const entries = state.ledger.expenses.filter(item => item.date === today).slice().reverse().map(item => ({ ...item, categoryName: names[item.category] || item.category, amountText: formatFen(item.amount) }));
    const left = remainingDailyBudget(state.ledger.expenses, today, state.config.dailyBudget);
    this.setData({ dailyBudget: formatFen(state.config.dailyBudget), remaining: formatFen(left), categories: state.categories, entries, closed: !!(state.daySlots[today] && state.daySlots[today].closed) });
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
    const amount = Number(this.data.keypadAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' });
      return;
    }
    const result = store.addExpense({ date: dateKey(), category: this.data.selectedCategory, amountYuan: amount });
    if (result.blocked) { this.setData({ keyboardVisible: false }); wx.showToast({ title: '今天已封账，可先撤销封账', icon: 'none' }); return; }
    this.setData({ amount: '', keypadAmount: '0', keyboardVisible: false, persisted: result.persisted });
    const left = remainingDailyBudget(result.state.ledger.expenses, dateKey(), result.state.config.dailyBudget);
    wx.showToast({ title: left < 0 ? `已记一笔，补差 ¥${formatFen(-left)}` : '已记一笔', icon: 'none' });
  },
  settleDay() {
    const result = store.settleDay({ date: dateKey(), dailyBudget: CONFIG.dailyBudget });
    wx.showToast({ title: result.alreadyClosed ? '今天已经封账' : (result.transfer ? `已退回 ¥${formatFen(result.transfer.amount)}` : '今天没有可退余额'), icon: 'none' });
  },
  reopenDay() {
    store.reopenDay(dateKey());
    wx.showToast({ title: '已撤销封账', icon: 'none' });
  }
});
