const { todayKey } = require('../../domain/calendar');
const { formatFen } = require('../../domain/money');
const store = require('../../store/store');
const { exportLedgerCsv } = require('../../utils/csv');
const { exportPaydayIcs } = require('../../utils/ics');

Page({
  data: { config: null, expenseCount: 0, mode: 'daily', acct: 'BANK1', acctIndex: 0, accountIds: ['BANK1', 'POOL2', 'POCKET3'], accountOptions: ['工资卡 ①', '余额宝 ②', '小荷包 ③'], realBalance: '', bookBalance: '', adjustNote: '', categoryName: '', categoryMark: '', categories: [] },
  onLoad() { this.unsubscribe = store.subscribe(() => this.refresh()); this.refresh(); },
  onShow() { this.refresh(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    const lastPeriod = state.periods && state.periods.length ? state.periods.at(-1) : null;
    this.setData({
      config: {
        ...state.config,
        dailyBudget: formatFen(state.config.dailyBudget),
        dailyBudgetYuan: formatFen(state.config.dailyBudget * 3),
        goalMinimum: formatFen(state.config.goalMinimum),
        targetSavings: lastPeriod ? formatFen(lastPeriod.pocketAfter) : '0.00'
      },
      expenseCount: state.ledger.expenses.length,
      mode: state.mode || 'daily',
      acct: this.data.accountIds[this.data.acctIndex],
      categories: state.categories
    });
  },
  exportCsv() {
    const csv = exportLedgerCsv(store.getState());
    wx.setClipboardData({ data: csv, success: () => wx.showToast({ title: 'CSV 已复制', icon: 'none' }) });
  },
  exportIcs() {
    const ics = exportPaydayIcs(store.getState().periods);
    if (wx.getFileSystemManager && wx.env && wx.env.USER_DATA_PATH) {
      const filePath = `${wx.env.USER_DATA_PATH}/55kuai2-paydays.ics`;
      try { wx.getFileSystemManager().writeFileSync(filePath, ics, 'utf8'); wx.openDocument({ filePath, fileType: 'ics', showMenu: true, fail: () => wx.setClipboardData({ data: ics, success: () => wx.showToast({ title: 'ICS 已复制', icon: 'none' }) }) }); return; } catch (error) { /* clipboard fallback */ }
    }
    wx.setClipboardData({ data: ics, success: () => wx.showToast({ title: 'ICS 已复制', icon: 'none' }) });
  },
  selectScenario(event) {
    const scenario = event.currentTarget.dataset.scenario;
    const state = store.getState();
    if (scenario === state.config.scenario) return;
    const executed = Object.keys(state.executedPaydays || {}).filter(key => state.executedPaydays[key]);
    store.setScenario(scenario);
    wx.showToast({ title: executed.length ? `已切换到 ${scenario}：已执行期次的流水不会改写` : `已切换到 ${scenario} 情景`, icon: 'none' });
  },
  selectAcct(event) { this.setData({ acctIndex: Number(event.detail.value) }, () => this.refresh()); },
  toggleMode() { store.setMode(this.data.mode === 'daily' ? 'three-day' : 'daily'); },
  inputReal(event) { this.setData({ realBalance: event.detail.value }); },
  inputBook(event) { this.setData({ bookBalance: event.detail.value }); },
  inputNote(event) { this.setData({ adjustNote: event.detail.value }); },
  saveAdjust() {
    if (this.data.realBalance === '' || this.data.bookBalance === '') { wx.showToast({ title: '请填写两项余额', icon: 'none' }); return; }
    store.addAdjust({ date: todayKey(), acct: this.data.acct, realBalanceYuan: this.data.realBalance, bookBalanceYuan: this.data.bookBalance, note: this.data.adjustNote });
    this.setData({ realBalance: '', bookBalance: '', adjustNote: '' });
    wx.showToast({ title: '校准已记录', icon: 'none' });
  },
  inputCategoryName(event) { this.setData({ categoryName: event.detail.value }); },
  inputCategoryMark(event) { this.setData({ categoryMark: event.detail.value }); },
  addCategory() {
    if (!this.data.categoryName) { wx.showToast({ title: '请输入分类名称', icon: 'none' }); return; }
    const result = store.addCategory({ id: store.newCategoryId(), name: this.data.categoryName, mark: this.data.categoryMark });
    if (result.blocked) { wx.showToast({ title: '分类已存在', icon: 'none' }); return; }
    this.setData({ categoryName: '', categoryMark: '' });
  },
  removeCategory(event) {
    const result = store.removeCategory(event.currentTarget.dataset.id);
    wx.showToast({ title: result.blocked ? '已使用的分类不能删除' : '分类已删除', icon: 'none' });
  },
  resetData() {
    wx.showModal({ title: '重置演示数据', content: '将清除本机流水和勾选状态，恢复初始计划。', confirmText: '确认重置', success: result => { if (result.confirm) { store.reset(); wx.showToast({ title: '已恢复初始数据', icon: 'none' }); } } });
  }
});
