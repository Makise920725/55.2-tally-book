// 写操作的统一收尾。
// store.commit 现在是「先落盘、后换内存」的：persisted:false 意味着这次改动根本没生效，
// 内存里的账本仍然等于磁盘上的账本。所以页面绝不能在拿到 persisted:false 时继续说「已记账」，
// 必须把失败当场说出来，并且不要清空输入框（让用户原样重试）。
const PERSIST_FAILED = '本机存储写入失败，本次改动没有保存，请重试';

function persistFailed(result) { return !result || result.persisted === false; }

// 用法：if (write.notify(result, '已记一笔')) { 清空输入 }
// 返回 true 表示这次写入真的落盘了。
function notify(result, successTitle) {
  if (persistFailed(result)) {
    wx.showToast({ title: PERSIST_FAILED, icon: 'none' });
    return false;
  }
  if (successTitle) wx.showToast({ title: successTitle, icon: 'none' });
  return true;
}

// 被业务规则挡住（计划已结束、批次已封账、同名分类……）时的提示：各页面给自己的文案表。
function notifyBlocked(result, texts, fallback) {
  const text = (result && texts[result.blocked]) || fallback || '现在还不能这样记';
  wx.showToast({ title: text, icon: 'none' });
  return false;
}

module.exports = { PERSIST_FAILED, persistFailed, notify, notifyBlocked };
