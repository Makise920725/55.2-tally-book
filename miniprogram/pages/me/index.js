const { todayKey } = require('../../domain/calendar');
const { formatFen } = require('../../domain/money');
const store = require('../../store/store');
const { exportLedgerCsv } = require('../../utils/csv');
const { exportPaydayIcs } = require('../../utils/ics');
const { buildLedgerEvents } = require('../../domain/ledger-view');
const backup = require('../../utils/backup');
const fileExport = require('../../utils/file');

Page({
  data: { config: null, expenseCount: 0, eventCount: 0, backupView: null, mode: 'daily', acct: 'BANK1', acctIndex: 0, accountIds: ['BANK1', 'POOL2', 'POCKET3'], accountOptions: ['工资卡 ①', '余额宝 ②', '小荷包 ③'], realBalance: '', bookBalance: '', adjustNote: '', categoryName: '', categoryMark: '', categories: [] },
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
      eventCount: buildLedgerEvents(state).length,
      backupView: this.backupView(),
      mode: state.mode || 'daily',
      acct: this.data.accountIds[this.data.acctIndex],
      categories: state.categories
    });
  },
  openLedger() { wx.navigateTo({ url: '/pages/ledger/index' }); },
  shortTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = value => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },
  backupView() {
    const meta = store.backupMeta();
    return {
      lastBackupText: meta.lastBackupAt ? `上次备份 ${this.shortTime(meta.lastBackupAt)}` : '尚未备份',
      lastRestoreText: meta.lastRestoreAt ? `上次恢复 ${this.shortTime(meta.lastRestoreAt)}` : '',
      canUndoRestore: meta.canUndoRestore,
      summary: backup.describeState(store.getState())
    };
  },
  // ---- 备份与恢复：完整快照走 JSON，CSV 仍然只是给人看的导出 ----
  backupNow() {
    const text = backup.createBackupText(store.getState());
    fileExport.deliverText({
      fileName: backup.backupFileName(fileExport.fileStamp()),
      content: text, fileType: 'json', label: '备份', preferShare: true,
      done: () => { store.markBackedUp(); this.refresh(); }
    });
  },
  restoreFromFile() {
    if (!wx.chooseMessageFile) { wx.showToast({ title: '请在小程序里选择聊天记录中的文件', icon: 'none' }); return; }
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['json'],
      success: result => {
        const file = result.tempFiles && result.tempFiles[0];
        if (!file) return;
        const fs = wx.getFileSystemManager();
        if (!fs || !fs.readFile) { wx.showToast({ title: '当前环境无法读取文件', icon: 'none' }); return; }
        fs.readFile({
          filePath: file.path, encoding: 'utf8',
          success: read => this.applyBackupText(read.data),
          fail: () => wx.showToast({ title: '读取文件失败', icon: 'none' })
        });
      },
      fail: () => wx.showToast({ title: '未选择文件', icon: 'none' })
    });
  },
  restoreFromClipboard() {
    wx.getClipboardData({ success: result => this.applyBackupText(result.data), fail: () => wx.showToast({ title: '剪贴板是空的', icon: 'none' }) });
  },
  applyBackupText(text) {
    const parsed = backup.parseBackupText(text);
    if (!parsed.ok) {
      wx.showModal({ title: '备份不可用', content: parsed.problems.join('\n'), showCancel: false });
      this.refresh();
      return;
    }
    const current = store.getState();
    const exportedAt = this.shortTime(parsed.meta.exportedAt);
    wx.showModal({
      title: '整体替换当前账本',
      content: `当前：${backup.describeState(current)}\n备份：${backup.describeState(parsed.state)}${exportedAt ? `（导出于 ${exportedAt}）` : ''}\n\n替换前会自动留下当前账本，可在本页一键撤销。`,
      confirmText: '确认恢复', cancelText: '先不动',
      success: result => {
        if (!result.confirm) return;
        const done = store.restoreFromBackup(parsed.state);
        wx.showToast({
          title: done.ok ? '已恢复备份' : (done.error === 'persist-failed' ? '本机存储写入失败，已退回原账本' : '恢复失败，账本未改动'),
          icon: 'none'
        });
        this.refresh();
      }
    });
  },
  undoRestore() {
    wx.showModal({
      title: '撤销上次恢复',
      content: '用恢复前留下的账本替换现在的账本。',
      confirmText: '撤销', cancelText: '先不动',
      success: result => {
        if (!result.confirm) return;
        const done = store.undoRestore();
        wx.showToast({ title: done.ok ? '已回到恢复前' : '没有可撤销的恢复', icon: 'none' });
        this.refresh();
      }
    });
  },
  // 导出主出口改为“写文件 + 打开/分享”，剪贴板只在两者都不可用时兜底。
  exportCsv() {
    const csv = exportLedgerCsv(store.getState());
    fileExport.deliverText({ fileName: `55kuai2-ledger-${fileExport.fileStamp()}.csv`, content: csv, fileType: 'csv', label: 'CSV' });
  },
  exportIcs() {
    const ics = exportPaydayIcs(store.getState().periods);
    fileExport.deliverText({ fileName: `55kuai2-paydays-${fileExport.fileStamp()}.ics`, content: ics, fileType: 'ics', label: 'ICS' });
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
  toggleMode(event) {
    const mode = event.detail.value ? 'three-day' : 'daily';
    const result = store.setMode(mode, todayKey());
    if (!result.blocked) return;
    this.refresh();
    const title = result.blocked === 'batch_boundary'
      ? '请在新三日批次首日切换'
      : `当前批次未结算，请于 ${result.settlementDate} 结算后切换`;
    wx.showToast({ title, icon: 'none' });
  },
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
