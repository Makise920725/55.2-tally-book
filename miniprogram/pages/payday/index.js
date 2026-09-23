const { derivePeriods, periodForDate } = require('../../domain/plan');
const { todayKey } = require('../../domain/calendar');
const { formatFen } = require('../../domain/money');
const store = require('../../store/store');
const { sum } = require('../../domain/ledger');
const sweep = require('../../utils/sweep');
const write = require('../../utils/write');

const STEP_NAMES = ['工资与生活费到账', '偿还账单（划转，不是支出）', '放入余额宝预算池', '存入小荷包', '清理上期结余'];
// 第五步不是一个勾：它是真金白银的 carry_over 转账，完成状态一律由流水派生。
const BLOCKED_TEXT = {
  ended: '计划已结束，账本转为只读',
  not_started: '计划还没开始',
  not_reached: '到账日到了再登记',
  derived_step: '第五步是真实转存：请用下面的按钮把余粮转入小荷包'
};

Page({
  data: { period: null, steps: [], periodIndex: 1, canSweep: false, sweepText: '', transferDone: false, allDone: false, completed: false, statusText: '', saveError: '', periodOptions: ['第 1 期', '第 2 期', '第 3 期', '第 4 期', '第 5 期'] },
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
    const item = state.periods[periodIndex - 1] || derivePeriods()[periodIndex - 1];
    // 五步的完成状态一律向 store 要：前四步是「这次划转登记了什么」，
    // 第五步只看该期次内有没有真实的 carry_over 流水——手点不出完成。
    const status = store.paydayStepStatus(state, periodIndex);
    // 第五步的可选金额一律来自 store 的余粮口径，页面不自己算。
    const surplus = store.previewPoolSurplus(todayKey());
    const steps = STEP_NAMES.map((name, index) => ({
      index: index + 1,
      name,
      derived: index === 4,
      done: status.done[index],
      amount: index === 0 ? formatFen(item.totalIn)
        : index === 1 ? formatFen(item.billTotal)
        : index === 2 ? formatFen(item.budgetToPool)
        : index === 3 ? formatFen(item.saveToPocket)
        : status.sweptFen ? `本期已转存小荷包 ¥${formatFen(status.sweptFen)}`
        : surplus.periodIndex === periodIndex && surplus.surplus ? `当前可清理 ¥${formatFen(surplus.surplus)}（超出本期剩余计划开销）`
        : '省多少转多少：真实转存后自动打勾'
    }));
    this.setData({
      period: { ...item, total: formatFen(item.totalIn), bill: formatFen(item.billTotal), budget: formatFen(item.budgetToPool), save: formatFen(item.saveToPocket) },
      steps,
      transferDone: status.transferDone,
      allDone: status.allDone,
      completed: status.allDone,
      statusText: status.allDone ? '五步完成，安心进入下一期'
        : status.transferDone ? '前四步已登记，第五步余粮还没转进小荷包'
        : '尚未执行：发薪日当天按五步走一遍',
      canSweep: surplus.surplus > 0 && !surplus.blocked && surplus.periodIndex === periodIndex,
      sweepText: surplus.surplus ? `第五步：清理余额宝余粮 ¥${formatFen(surplus.surplus)} → 小荷包` : '第五步：本阶段没有可清理的余粮'
    });
  },
  togglePeriod(event) { this.setData({ periodIndex: Number(event.detail.value) + 1 }, () => this.refresh()); },
  toggleStep(event) {
    const result = store.togglePaydayStep(this.data.periodIndex, event.currentTarget.dataset.step, todayKey());
    this.setSaveError(result);
    if (result.blocked) { write.notifyBlocked(result, BLOCKED_TEXT, '这一步现在改不了'); return; }
    write.notify(result, '');
  },
  // 存储写失败是全局状态：横幅留在页面上，直到下一次写入成功才消失。
  setSaveError(result) { this.setData({ saveError: write.persistFailed(result) ? write.PERSIST_FAILED : '' }); },
  sweepSurplus() { sweep.sweepWithConfirm(() => this.refresh()); },
  execute() {
    const result = store.executePayday(this.data.periodIndex, todayKey());
    this.setSaveError(result);
    if (result.blocked) { write.notifyBlocked(result, BLOCKED_TEXT, `本期到账日是 ${result.payDate}，到账后再登记`); return; }
    write.notify(result, result.alreadyExecuted ? '本期已执行' : '前四步划转已登记，第五步请确认转入小荷包');
  },
});
