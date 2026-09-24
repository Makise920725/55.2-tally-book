const { derivePeriods, periodForDate } = require('../../domain/plan');
const { todayKey } = require('../../domain/calendar');
const { formatFen } = require('../../domain/money');
const store = require('../../store/store');
const sweep = require('../../utils/sweep');
const write = require('../../utils/write');

// SOP 六步：两笔到账 + 三步划转 + 清理余粮。每一步的完成状态都由真实流水派生，页面不再手勾。
const STEP_NAMES = ['工资到账', '生活费到账', '偿还账单（划转，不是支出）', '放入余额宝预算池', '存入小荷包', '清理上期结余'];
// 被业务规则拒绝时的提示：store 是唯一裁决者，页面只负责说清原因。
const BLOCKED_TEXT = {
  ended: '计划已结束，账本转为只读',
  not_started: '计划还没开始',
  not_reached: '到账日到了再登记',
  derived_step: '步骤完成以真实流水为准，不用手勾',
  salary_pending: '先登记工资到账，再登记生活费',
  outside_range: '生活费要落在本期区间内',
  bad_date: '请选择到账日期',
  already_received: '本期生活费已经登记过了'
};

Page({
  data: {
    period: null, steps: [], periodIndex: 1, canSweep: false, sweepText: '',
    transferDone: false, allDone: false, completed: false, statusText: '', saveError: '',
    periodOptions: ['第 1 期', '第 2 期', '第 3 期', '第 4 期', '第 5 期'],
    canRegisterSalary: false, canRegisterAllowance: false, salaryButtonText: '', allowanceButtonText: ''
  },
  onLoad() {
    this.selectCurrentPeriod();
    this.unsubscribe = store.subscribe(() => this.refresh());
    this.refresh();
  },
  onShow() { this.selectCurrentPeriod(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  // 默认停在“今天所属期次”：计划开始前落到第 1 期，全部结束后落到最后一期。
  selectCurrentPeriod() {
    const state = store.getState();
    const periods = state.periods || derivePeriods();
    const item = periodForDate(todayKey(), periods);
    const last = periods[periods.length - 1];
    const periodIndex = item ? item.index : (todayKey() < periods[0].payDate ? periods[0].index : last.index);
    this.setData({ periodIndex });
  },
  refresh() {
    const state = store.getState();
    const periodIndex = this.data.periodIndex || 1;
    const today = todayKey();
    const item = state.periods[periodIndex - 1] || derivePeriods()[periodIndex - 1];
    const status = store.paydayStepStatus(state, periodIndex);
    const surplus = store.previewPoolSurplus(today);
    // 两段到账的金额与待办：工资日给「已安置/还差多少」，生活费日给「到账后会自动补多少池、存多少」。
    const allowancePlan = item.allowancePlan;
    const steps = STEP_NAMES.map((name, index) => {
      const flowText = index === 0
        ? (item.salaryReceived ? `¥${formatFen(item.salary)} · 已到账 ${item.payDate}` : `¥${formatFen(item.salary)} · 到账日 ${item.payDate}`)
        : index === 1
          ? (item.allowanceReceived
            ? `¥${formatFen(item.allowanceIn)} · 已到账 ${item.allowanceDate}`
            : `¥${formatFen(item.allowance)} · 预计 ${item.allowanceExpectedDate}${item.salaryReceived ? '' : '（先登记工资）'}`)
          : index === 2
            ? `${item.billPlaced >= item.planBill ? '已还清' : `已还 ¥${formatFen(item.billPlaced)}`} / ¥${formatFen(item.planBill)}${item.pendingBill ? ` · 还差 ¥${formatFen(item.pendingBill)}` : ''}`
            : index === 3
              ? `${item.poolPlaced >= item.planBudget ? '已补满' : `已入池 ¥${formatFen(item.poolPlaced)}`} / ¥${formatFen(item.planBudget)}${item.pendingPool && allowancePlan ? ` · 生活费到账后补 ¥${formatFen(allowancePlan.pool)}` : ''}`
              : index === 4
                ? `${item.savePlaced >= item.planSave ? '已存够' : `已存 ¥${formatFen(item.savePlaced)}`} / ¥${formatFen(item.planSave)}${item.pendingSave && allowancePlan ? ` · 生活费到账后存 ¥${formatFen(allowancePlan.save)}` : ''}`
                : status.sweptFen ? `本期已转存小荷包 ¥${formatFen(status.sweptFen)}`
                  : surplus.periodIndex === periodIndex && surplus.surplus ? `当前可清理 ¥${formatFen(surplus.surplus)}（超出本期剩余计划开销）`
                    : '省多少转多少：真实转存后自动打勾';
      return { index: index + 1, name, done: status.done[index], flowText };
    });
    const salaryPending = !item.salaryReceived;
    const allowancePending = !item.allowanceReceived;
    this.setData({
      period: {
        ...item,
        total: formatFen(item.totalIn), salaryText: formatFen(item.salary), allowanceText: formatFen(item.allowanceIn),
        bill: formatFen(item.planBill), budget: formatFen(item.planBudget), save: formatFen(item.planSave),
        allowanceHint: allowancePlan
          ? `生活费到账后：先补预算池 ¥${formatFen(allowancePlan.pool)}，再转存 ¥${formatFen(allowancePlan.save)}`
          : ''
      },
      steps,
      transferDone: status.transferDone,
      allDone: status.allDone,
      completed: status.allDone,
      statusText: status.allDone ? '六步完成，安心进入下一期'
        : !item.salaryReceived ? `工资还没登记：到账后先登记工资（${item.payDate}）`
        : !item.allowanceReceived ? `工资已安置，等生活费到账后登记（预计 ${item.allowanceExpectedDate}）`
        : status.done.slice(2, 5).every(Boolean) ? '两笔收入已安置，第六步余粮还没转进小荷包'
        : '两笔收入已到账，划转还没补齐（点下面的按钮核对后重试）',
      canSweep: surplus.surplus > 0 && !surplus.blocked && surplus.periodIndex === periodIndex,
      sweepText: surplus.surplus ? `清理余额宝余粮 ¥${formatFen(surplus.surplus)} → 小荷包` : '本阶段没有可清理的余粮',
      // 工资日过了就能登记工资；生活费要等工资登记之后，且到账日落在本期内。
      canRegisterSalary: salaryPending && item.payDate <= today && today <= state.config.deadline,
      canRegisterAllowance: salaryPending === false && allowancePending && today >= item.payDate && today <= state.config.deadline,
      // 日期选择器只能在「工资日 ~ min(今天, 本期结束)」里选：不允许把还没发生的到账登记成事实。
      allowancePickerValue: today >= item.payDate ? (today <= item.rangeEnd ? today : item.rangeEnd) : item.payDate,
      allowancePickerEnd: today < item.rangeEnd ? today : item.rangeEnd,
      // v1.3 及更早版本把工资与生活费合并成一笔登记：金额不动，但要说清楚这回事。
      legacyHint: item.legacyMerged
        ? `本期由旧版本合并登记（工资 + 生活费一笔）。历史金额一分未改；若生活费实际还没到账，请在到账后核对一次账户真实余额。`
        : '',
      salaryButtonText: salaryPending ? `登记工资到账 ¥${formatFen(item.salary)}` : '工资已登记',
      allowanceButtonText: salaryPending ? '先登记工资到账' : (allowancePending ? `登记生活费到账 ¥${formatFen(item.allowance)}` : '生活费已登记')
    });
  },
  togglePeriod(event) { this.setData({ periodIndex: Number(event.detail.value) + 1 }, () => this.refresh()); },
  // 两步到账：工资日直接登记；生活费支持选实际到账日（默认今天，不早于工资日、不晚于本期结束）。
  registerSalary() {
    const result = store.registerSalaryDay(this.data.periodIndex, todayKey());
    this.setSaveError(result);
    if (result.blocked) { write.notifyBlocked(result, BLOCKED_TEXT, '现在不能登记工资'); return; }
    write.notify(result, result.alreadyReceived ? '本期工资已登记' : '工资已登记，先还账单、补预算池');
  },
  // 生活费是一笔真实的进账，登记即写 5 笔账：先确认再落盘，和第六步转账同样的纪律。
  registerAllowance(event) {
    const picked = event && event.detail ? event.detail.value : '';
    const date = picked || todayKey();
    const item = this.data.period;
    const preview = item && item.allowancePlan;
    const content = `确认 ¥${formatFen(item.allowance)} 生活费已于 ${date} 到账？\n登记后：`
      + `先补预算池 ¥${preview ? formatFen(preview.pool) : "0.00"}，`
      + `再转存 ¥${preview ? formatFen(preview.save) : "0.00"} 进小荷包。`;
    wx.showModal({
      title: '登记生活费到账',
      content,
      confirmText: '确认到账', cancelText: '还没到',
      success: result => { if (result.confirm) this.applyAllowance(date); }
    });
  },
  applyAllowance(date) {
    const result = store.registerAllowance(this.data.periodIndex, { date, asOfDate: todayKey() });
    this.setSaveError(result);
    if (result.blocked) { write.notifyBlocked(result, BLOCKED_TEXT, '现在不能登记生活费'); return; }
    write.notify(result, result.alreadyReceived ? '本期生活费已登记' : '生活费已登记：补足预算池，余下转入小荷包');
  },
  // 存储写失败是全局状态：横幅留在页面上，直到下一次写入成功才消失。
  setSaveError(result) { this.setData({ saveError: write.persistFailed(result) ? write.PERSIST_FAILED : '' }); },
  toggleStep(event) {
    const result = store.togglePaydayStep(this.data.periodIndex, event.currentTarget.dataset.step, todayKey());
    if (result.blocked) { write.notifyBlocked(result, BLOCKED_TEXT, '这一步现在改不了'); return; }
    write.notify(result, '');
  },
  sweepSurplus() { sweep.sweepWithConfirm(() => this.refresh()); }
});
