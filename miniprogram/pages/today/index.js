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
  data: { dailyBudget: formatFen(CONFIG.dailyBudget), remaining: formatFen(CONFIG.dailyBudget), amount: '', selectedCategory: 'meal', categories: [], entries: [], persisted: true },
  onLoad() {
    this.unsubscribe = store.subscribe(() => this.refresh());
    this.refresh();
  },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    const today = dateKey();
    const entries = state.ledger.expenses.filter(item => item.date === today).slice().reverse();
    const left = remainingDailyBudget(state.ledger.expenses, today, state.config.dailyBudget);
    this.setData({ dailyBudget: formatFen(state.config.dailyBudget), remaining: formatFen(left), categories: state.categories, entries });
  },
  selectCategory(event) { this.setData({ selectedCategory: event.currentTarget.dataset.category }); },
  inputAmount(event) { this.setData({ amount: event.detail.value }); },
  addExpense() {
    const amount = Number(this.data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' });
      return;
    }
    const result = store.addExpense({ date: dateKey(), category: this.data.selectedCategory, amountYuan: amount });
    this.setData({ amount: '', persisted: result.persisted });
    wx.showToast({ title: result.persisted ? '已记一笔' : '已记入本机内存', icon: 'none' });
  },
  settleDay() {
    const result = store.settleDay({ date: dateKey(), dailyBudget: CONFIG.dailyBudget });
    wx.showToast({ title: result.transfer ? `已退回 ¥${formatFen(result.transfer.amount)}` : '今天没有可退余额', icon: 'none' });
  }
});
