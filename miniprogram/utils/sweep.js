// 第六步「清理上期结余」是真实的跨账户转账（余额宝②→小荷包③），
// 所以任何页面都必须“先确认、再写账”，而且金额一律来自 store 的余粮口径，页面不自己算。
const store = require('../store/store');
const { formatFen } = require('../domain/money');
const { todayKey } = require('../domain/calendar');
const write = require('./write');

function describe(preview) {
  return '余额宝 ¥' + formatFen(preview.poolBalance) + '，第 ' + preview.periodIndex + ' 期剩余 ' + preview.remainingDays
    + ' 天按计划只需 ¥' + formatFen(preview.remainingNeed)
    + '。把多出来的 ¥' + formatFen(preview.surplus) + ' 转进小荷包？转完余额宝只剩本期要用的钱，之后没花完还能再清理。';
}

// 页面唯一的入口：弹窗确认后才写账，写完回调刷新。返回 false 表示当下没有什么可转的。
function sweepWithConfirm(onDone) {
  const date = todayKey();
  const preview = store.previewPoolSurplus(date);
  if (preview.blocked === 'ended') {
    wx.showToast({ title: '计划已于 ' + preview.deadline + ' 结束，账本只读', icon: 'none' });
    return false;
  }
  if (preview.blocked === 'not_started') {
    wx.showToast({ title: '计划还没开始，余额宝还不会有余粮', icon: 'none' });
    return false;
  }
  if (preview.blocked) {
    wx.showToast({ title: '这天不在任何期次里，先选一个周期', icon: 'none' });
    return false;
  }
  if (!preview.surplus) {
    wx.showToast({ title: '余额宝里没有超出计划开销的余粮', icon: 'none' });
    return false;
  }
  wx.showModal({
    title: '清理余额宝余粮',
    content: describe(preview),
    confirmText: '转入小荷包',
    cancelText: '先不转',
    success: result => {
      if (!result.confirm) return;
      const swept = store.sweepPoolSurplus({ asOfDate: date });
      if (swept.blocked) wx.showToast({ title: swept.blocked === 'ended' ? '计划已结束，账本转为只读' : '现在不能清理余粮', icon: 'none' });
      else if (swept.skipped) wx.showToast({ title: '已经没有可清理的余粮了', icon: 'none' });
      // 只有真的落盘才说「已转入小荷包」：这一步的完成状态正是由这条 carry_over 流水派生的。
      else write.notify(swept, '已转入小荷包 ¥' + formatFen(swept.swept));
      if (onDone) onDone(swept);
    }
  });
  return true;
}

module.exports = { sweepWithConfirm, describe };
