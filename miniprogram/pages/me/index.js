const { CONFIG } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');
const store = require('../../store/store');
const { exportLedgerCsv } = require('../../utils/csv');

Page({
  data: { config: null, expenseCount: 0, mode: 'daily', realBalance: '', bookBalance: '', adjustNote: '' },
  onLoad() { this.unsubscribe = store.subscribe(() => this.refresh()); this.refresh(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    this.setData({ config: { ...CONFIG, dailyBudget: formatFen(CONFIG.dailyBudget), goalMinimum: formatFen(CONFIG.goalMinimum), targetSavings: formatFen(CONFIG.targetSavings) }, expenseCount: state.ledger.expenses.length, mode: state.mode || 'daily' });
  },
  exportCsv() {
    const csv = exportLedgerCsv(store.getState());
    wx.setClipboardData({ data: csv, success: () => wx.showToast({ title: 'CSV 已复制', icon: 'none' }) });
  },
  toggleMode() { store.setMode(this.data.mode === 'daily' ? 'three-day' : 'daily'); },
  inputReal(event) { this.setData({ realBalance: event.detail.value }); },
  inputBook(event) { this.setData({ bookBalance: event.detail.value }); },
  inputNote(event) { this.setData({ adjustNote: event.detail.value }); },
  saveAdjust() {
    if (this.data.realBalance === '' || this.data.bookBalance === '') { wx.showToast({ title: '请填写两项余额', icon: 'none' }); return; }
    store.addAdjust({ date: new Date().toISOString().slice(0, 10), acct: 'BANK1', realBalanceYuan: this.data.realBalance, bookBalanceYuan: this.data.bookBalance, note: this.data.adjustNote });
    this.setData({ realBalance: '', bookBalance: '', adjustNote: '' });
    wx.showToast({ title: '校准已记录', icon: 'none' });
  },
  resetData() {
    wx.showModal({ title: '重置演示数据', content: '将清除本机流水和勾选状态，恢复初始计划。', confirmText: '确认重置', success: result => { if (result.confirm) { store.reset(); wx.showToast({ title: '已恢复初始数据', icon: 'none' }); } } });
  }
});
