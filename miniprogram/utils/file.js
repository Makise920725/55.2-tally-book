// 小程序端「看完整账本」的文件出口。
// 微信的各项能力在不同基础库 / 真机上并不齐活：wx.openDocument 只保证 office 与 pdf 类型、
// wx.shareFileMessage 在部分环境根本不存在、剪贴板也可能被禁用。
// 因此这里是一条显式降级链，每一环先做能力检测（而不是假设它存在）：
//   写文件 → 发送文件（备份 JSON 这类不可预览的文件优先走这里）→ 打开文档 → 剪贴板 → 明确失败
// 完成回调 done(channel) 全程最多触发一次：备份成功后的 store.markBackedUp() 才不会漏记，
// 也不会出现「成功和失败各弹一次提示」。
function pad(value) { return String(value).padStart(2, '0'); }

function fileStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function has(capability) { return typeof wx !== 'undefined' && typeof wx[capability] === 'function'; }

function toast(title) { if (has('showToast')) wx.showToast({ title, icon: 'none' }); }

// 只允许触发一次的回调包装（微信的 success/fail 理论上互斥，但降级链会串起多个出口，必须兜住）。
function once(fn) {
  let fired = false;
  return value => { if (fired) return undefined; fired = true; return fn(value); };
}

function userPath(fileName) {
  if (typeof wx === 'undefined' || !wx.env || !wx.env.USER_DATA_PATH) return '';
  return `${wx.env.USER_DATA_PATH}/${fileName}`;
}

function writeTextFile(fileName, content) {
  const filePath = userPath(fileName);
  const fs = has('getFileSystemManager') ? wx.getFileSystemManager() : null;
  if (!filePath || !fs || typeof fs.writeFileSync !== 'function') return { ok: false, error: 'unsupported' };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  } catch (error) {
    return { ok: false, error };
  }
}

function copyToClipboard(content, label, done) {
  const finish = once(done);
  if (!has('setClipboardData')) { toast(`${label} 导出失败：当前环境不支持剪贴板`); finish(null); return; }
  wx.setClipboardData({
    data: content,
    success: () => { toast(`${label} 已复制到剪贴板`); finish('clipboard'); },
    fail: () => { toast(`${label} 导出失败`); finish(null); },
    complete: () => finish(null)
  });
}

function shareFile({ filePath, fileName, label }, finish, next) {
  wx.shareFileMessage({
    filePath,
    fileName,
    success: () => { toast('文件已发送，可在会话中打开'); finish('share'); },
    fail: () => next()
  });
}

function openDocument({ filePath, fileType }, finish, next) {
  wx.openDocument({
    filePath,
    fileType,
    showMenu: true,
    success: () => finish('openDocument'),
    fail: () => next()
  });
}

function clipboardExit({ content, label }, finish) {
  wx.setClipboardData({
    data: content,
    success: () => { toast(`${label} 已复制到剪贴板`); finish('clipboard'); },
    // 剪贴板是最后一环：它也失败就没有下家了，当场说清楚，不能静默。
    fail: () => { toast(`${label} 导出失败`); finish(null); }
  });
}

// 依次尝试出口；每一环只有自己这条失败才会往下走，全部走不通才明确报失败。
function runChain(steps, payload, finish) {
  const attempt = index => {
    if (index >= steps.length) { toast('当前环境无法导出，请稍后重试'); finish(null); return; }
    // once 兜住微信可能先 fail 再 complete 的重复回调：一环只继续下一环一次。
    const next = once(() => attempt(index + 1));
    steps[index].attempt(payload, finish, next);
  };
  attempt(0);
}

// { fileName, content, fileType, label, preferShare, done }
// preferShare：备份 JSON 这类无法预览的文件，主出口是直接发送文件（换机要用）。
// 返回 { ok, channel, filePath }：channel 记录真正走通的出口（同步环境里即时可得，异步环境为最终出口）。
function deliverText({ fileName, content, fileType, label = '文件', preferShare = false, done }) {
  let used = '';
  const finish = once(channel => {
    used = channel || '';
    if (typeof done === 'function') done(channel);
  });
  const written = writeTextFile(fileName, content);
  const payload = { filePath: written.ok ? written.filePath : '', fileName, content, fileType, label };
  const share = written.ok && has('shareFileMessage') ? { name: 'share', attempt: shareFile } : null;
  const open = written.ok && has('openDocument') ? { name: 'openDocument', attempt: openDocument } : null;
  const clipboard = has('setClipboardData') ? { name: 'clipboard', attempt: clipboardExit } : null;
  const steps = (written.ok ? (preferShare ? [share, open, clipboard] : [open, share, clipboard]) : [clipboard]).filter(Boolean);
  runChain(steps, payload, finish);
  return { ok: Boolean(used), channel: used || 'none', filePath: payload.filePath };
}

module.exports = { fileStamp, userPath, writeTextFile, deliverText, copyToClipboard };
