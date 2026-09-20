// 小程序端「看完整账本」的文件出口。
// wx.openDocument 官方只保证 doc/docx/xls/xlsx/ppt/pptx/pdf，CSV/ICS 这类可能被拒；
// 因此三级兜底：写文件 -> openDocument -> shareFileMessage（发给文件传输助手后用其他应用打开）-> 剪贴板。
// 剪贴板只是最后的兼容通道，不再是主出口。
function pad(value) { return String(value).padStart(2, '0'); }

function fileStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function userPath(fileName) {
  if (!wx.env || !wx.env.USER_DATA_PATH) return '';
  return `${wx.env.USER_DATA_PATH}/${fileName}`;
}

function writeTextFile(fileName, content) {
  const filePath = userPath(fileName);
  const fs = wx.getFileSystemManager && wx.getFileSystemManager();
  if (!filePath || !fs) return { ok: false, error: 'unsupported' };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  } catch (error) {
    return { ok: false, error };
  }
}

function copyToClipboard(content, label, done) {
  wx.setClipboardData({
    data: content,
    success: () => wx.showToast({ title: `${label} 已复制到剪贴板`, icon: 'none' }),
    fail: () => wx.showToast({ title: `${label} 导出失败`, icon: 'none' }),
    complete: () => { if (done) done('clipboard'); }
  });
}

function shareOrClipboard(filePath, content, label, done) {
  const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
  if (!wx.shareFileMessage) { copyToClipboard(content, label); return; }
  wx.shareFileMessage({
    filePath,
    fileName,
    success: () => wx.showToast({ title: '文件已发送，可在会话中打开', icon: 'none' }),
    fail: () => copyToClipboard(content, label, done)
  });
}

function openOrClipboard(filePath, content, fileType, label, done) {
  wx.openDocument({
    filePath,
    fileType,
    showMenu: true,
    fail: () => shareOrClipboard(filePath, content, label, done),
    success: () => { if (done) done('openDocument'); }
  });
  return { ok: true, channel: 'openDocument', filePath };
}

// { fileName, content, fileType, label, preferShare, done }
// preferShare：备份 JSON 这类无法预览的文件，主出口是直接发送文件（换机要用）。
function deliverText({ fileName, content, fileType, label = '文件', preferShare = false, done }) {
  const written = writeTextFile(fileName, content);
  if (!written.ok) { copyToClipboard(content, label, done); return { ok: false, channel: 'clipboard' }; }
  if (preferShare && wx.shareFileMessage) {
    wx.shareFileMessage({
      filePath: written.filePath,
      fileName,
      success: () => { if (done) done('share'); wx.showToast({ title: '备份已发送，可转存到聊天记录', icon: 'none' }); },
      fail: () => openOrClipboard(written.filePath, content, fileType, label, done)
    });
    return { ok: true, channel: 'share', filePath: written.filePath };
  }
  return openOrClipboard(written.filePath, content, fileType, label, done);
}

module.exports = { fileStamp, userPath, writeTextFile, deliverText, copyToClipboard };
