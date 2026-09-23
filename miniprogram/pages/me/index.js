const { todayKey } = require('../../domain/calendar');
const { SCENARIOS } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');
const store = require('../../store/store');
const { exportLedgerCsv } = require('../../utils/csv');
const { exportPaydayIcs } = require('../../utils/ics');
const { buildLedgerEvents } = require('../../domain/ledger-view');
const backup = require('../../utils/backup');
const fileExport = require('../../utils/file');
const write = require('../../utils/write');

// 设置页写入口的拒绝原因：只读边界、输入校验、分类冲突都得说得清楚。
const BLOCKED_TEXT = {
  ended: '计划已结束，账本转为只读',
  not_started: '计划还没开始',
  batch_boundary: '请在新三日批次首日切换',
  active_batch: '当前批次未结算',
  bad_account: '请选择要校准的账户',
  bad_amount: '余额只能填数字，最多两位小数',
  invalid: '分类名称不合法：1-12 个字，标记最多 2 个字符',
  duplicate: '这个分类已经存在',
  duplicate_name: '已经有同名分类了',
  used: '已使用的分类不能删除'
};

Page({
  data: { config: null, expenseCount: 0, eventCount: 0, backupView: null, mode: 'daily', acct: 'BANK1', acctIndex: 0, accountIds: ['BANK1', 'POOL2', 'POCKET3'], accountOptions: ['工资卡 ①', '余额宝 ②', '小荷包 ③'], realBalance: '', bookBalance: '', adjustNote: '', categoryName: '', categoryMark: '', categories: [] },
  onLoad() { this.unsubscribe = store.subscribe(() => this.refresh()); this.refresh(); },
  onShow() { this.refresh(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    const lastPeriod = state.periods && state.periods.length ? state.periods[state.periods.length - 1] : null;
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
      // 只有真走通一个出口（发送文件 / 打开文档 / 剪贴板）才算备份完成；
      // 全链路都不可用时不能把「上次备份」时间往前推，否则用户以为已经留了快照。
      done: channel => {
        if (channel) store.markBackedUp();
        this.refresh();
      }
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
  // 情景只决定“往后按多少花”：已执行期次的金额以流水为准，不会被追溯改写，
  // 弹窗里必须把这条边界说清楚，用户才知道切完之后哪些数字会变、哪些不会。
  selectScenario(event) {
    const scenario = event.currentTarget.dataset.scenario;
    const state = store.getState();
    if (scenario === state.config.scenario) return;
    const dailyBudget = formatFen(SCENARIOS[scenario]);
    const frozen = (state.periods || []).filter(item => item.executed).map(item => `第 ${item.index} 期`);
    wx.showModal({
      title: `切换到 ${scenario}（¥${dailyBudget}/天）`,
      content: frozen.length
        ? `已执行的 ${frozen.join('、')} 保持实际转账金额不变；其余期次与储蓄轨迹按 ¥${dailyBudget}/天 重算。已封账的日结算不受影响。`
        : `五期预算与储蓄轨迹按 ¥${dailyBudget}/天 重算。已封账的日结算按实际划入金额退款，不受影响。`,
      confirmText: '切换',
      cancelText: '保持不动',
      success: result => {
        if (!result.confirm) return;
        const changed = store.setScenario(scenario, todayKey());
        this.refresh();
        if (changed.blocked) { write.notifyBlocked(changed, BLOCKED_TEXT, '现在不能调整预算情景'); return; }
        const replanned = changed.replanned.length ? `重算 ${changed.replanned.map(index => `第 ${index} 期`).join('、')}` : '五期均已按流水锁定';
        write.notify(changed, `已切换到 ${scenario} · ${replanned}`);
      }
    });
  },
  selectAcct(event) { this.setData({ acctIndex: Number(event.detail.value) }, () => this.refresh()); },
  toggleMode(event) {
    const mode = event.detail.value ? 'three-day' : 'daily';
    const result = store.setMode(mode, todayKey());
    if (result.blocked) {
      this.refresh();
      const title = result.blocked === 'active_batch' ? `当前批次未结算，请于 ${result.settlementDate} 结算后切换` : (BLOCKED_TEXT[result.blocked] || '现在不能切换结算模式');
      wx.showToast({ title, icon: 'none' });
      return;
    }
    this.refresh();
    if (result.unchanged) return;
    write.notify(result, mode === 'three-day' ? '已切换为三天一结' : '已切换为每日一结');
  },
  inputReal(event) { this.setData({ realBalance: event.detail.value }); },
  inputBook(event) { this.setData({ bookBalance: event.detail.value }); },
  inputNote(event) { this.setData({ adjustNote: event.detail.value }); },
  saveAdjust() {
    if (this.data.realBalance === '' || this.data.bookBalance === '') { wx.showToast({ title: '请填写两项余额', icon: 'none' }); return; }
    const result = store.addAdjust({ date: todayKey(), acct: this.data.acct, realBalanceYuan: this.data.realBalance, bookBalanceYuan: this.data.bookBalance, note: this.data.adjustNote });
    if (result.blocked) { write.notifyBlocked(result, BLOCKED_TEXT, '现在不能记录校准'); return; }
    if (!write.notify(result, '校准已记录')) return;
    this.setData({ realBalance: '', bookBalance: '', adjustNote: '' });
  },
  inputCategoryName(event) { this.setData({ categoryName: event.detail.value }); },
  inputCategoryMark(event) { this.setData({ categoryMark: event.detail.value }); },
  addCategory() {
    if (!this.data.categoryName) { wx.showToast({ title: '请输入分类名称', icon: 'none' }); return; }
    const result = store.addCategory({ id: store.newCategoryId(), name: this.data.categoryName, mark: this.data.categoryMark });
    if (result.blocked) { write.notifyBlocked(result, BLOCKED_TEXT, '分类保存失败'); return; }
    if (write.notify(result, '分类已添加')) this.setData({ categoryName: '', categoryMark: '' });
  },
  removeCategory(event) {
    const result = store.removeCategory(event.currentTarget.dataset.id);
    if (result.blocked) { write.notifyBlocked(result, BLOCKED_TEXT, '这个分类删不掉'); return; }
    write.notify(result, '分类已删除');
  },
  resetData() {
    wx.showModal({ title: '重置演示数据', content: '将清除本机流水和勾选状态，恢复初始计划。', confirmText: '确认重置', success: result => { if (result.confirm) write.notify(store.reset(), '已恢复初始数据'); } });
  }
});
