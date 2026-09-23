// P2 回归：导出/备份的降级链要按能力检测逐环兜底，完成回调最多触发一次。
// 少了哪一环都不能出现「用户以为备份好了、其实什么都没导出」或「done 丢了 → 上次备份时间不更新」。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const store = require('../miniprogram/store/store');
const file = require('../miniprogram/utils/file');

const WRITABLE = { writeFileSync: () => {} };

// capabilities: { fs, share, open, clipboard }；calls 记录每一环被调用的次数
function useWx(capabilities = {}) {
  const map = new Map();
  const calls = { toast: [], written: 0, shared: 0, opened: 0, clipboard: 0, map };
  const wx = {
    getStorageSync: key => (map.has(key) ? map.get(key) : ''),
    setStorageSync: (key, value) => map.set(key, value),
    removeStorageSync: key => map.delete(key),
    showToast: options => calls.toast.push(options.title)
  };
  if (capabilities.fs !== false) {
    wx.env = { USER_DATA_PATH: '/tmp/tally-file' };
    wx.getFileSystemManager = () => WRITABLE;
  }
  if (capabilities.share !== false) {
    wx.shareFileMessage = options => {
      calls.shared += 1;
      if (capabilities.shareFails) options.fail({ errMsg: 'shareFileMessage:fail' });
      else options.success({});
      if (capabilities.doubleCallback) options.complete && options.complete({});
    };
  }
  if (capabilities.open !== false) {
    wx.openDocument = options => {
      calls.opened += 1;
      if (capabilities.openFails) options.fail({ errMsg: 'openDocument:fail' });
      else options.success({});
    };
  }
  if (capabilities.clipboard !== false) {
    wx.setClipboardData = options => {
      calls.clipboard += 1;
      if (capabilities.clipboardFails) options.fail({ errMsg: 'setClipboardData:fail' });
      else options.success({});
      if (options.complete) options.complete({});   // 真机上 complete 一定会再来一次
    };
  }
  global.wx = wx;
  return calls;
}

function mount(relative) {
  let config = null;
  global.Page = options => { config = options; };
  const target = require.resolve(path.join(__dirname, relative));
  delete require.cache[target];
  require(target);
  const page = { data: { ...config.data } };
  Object.keys(config).forEach(key => {
    if (typeof config[key] === 'function') page[key] = config[key].bind(page);
    else if (key !== 'data') page[key] = config[key];
  });
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  return page;
}

const deliver = (options) => {
  const channels = [];
  const result = file.deliverText({ fileName: 'x.csv', content: 'a,b', fileType: 'csv', label: 'CSV', ...options, done: channel => channels.push(channel) });
  return { result, channels };
};

test('写文件成功但没有分享能力时，走 openDocument 并且回调只触发一次', () => {
  const calls = useWx({ share: false });
  const { channels } = deliver({ preferShare: true });
  assert.equal(calls.opened, 1);
  assert.deepEqual(channels, ['openDocument'], 'success 之后 complete 不能再补一次回调');
});

test('openDocument 不存在（而不是失败）也不会抛 TypeError，继续降级到剪贴板', () => {
  const calls = useWx({ open: false });
  const { channels } = deliver({ preferShare: false });
  assert.equal(calls.shared, 1, '没有预览能力时改用发送文件');
  assert.deepEqual(channels, ['share']);
});

test('发送文件失败 → 打开文档 → 剪贴板：一环走不通就换下一环', () => {
  const calls = useWx({ shareFails: true, openFails: true });
  const { channels } = deliver({ preferShare: true });
  assert.equal(calls.shared, 1);
  assert.equal(calls.opened, 1);
  assert.equal(calls.clipboard, 1);
  assert.deepEqual(channels, ['clipboard'], '备份的 done 必须落到真正走通的那一环');
});

test('写不进文件也不抛：直接兜到剪贴板', () => {
  const calls = useWx({ fs: false });
  const { channels } = deliver({ preferShare: true });
  assert.equal(calls.shared, 0, '没有落盘的文件就没有可发送的文件');
  assert.equal(calls.clipboard, 1);
  assert.deepEqual(channels, ['clipboard']);
});

test('所有出口都不可用时明确报失败，回调带 null 而不是永远不触发', () => {
  const calls = useWx({ fs: false, share: false, open: false, clipboard: false });
  const { channels } = deliver({ preferShare: true });
  assert.deepEqual(channels, [null], '不能静默：导出失败也要有回调');
  assert.ok(calls.toast.some(title => title.includes('无法导出')));
});

test('剪贴板本身失败时也只有一个回调，并提示导出失败', () => {
  const calls = useWx({ open: false, share: false, clipboardFails: true });
  const { channels } = deliver({});
  assert.equal(calls.clipboard, 1);
  assert.deepEqual(channels, [null]);
  assert.ok(calls.toast.some(title => title.includes('导出失败')));
});

test('copyToClipboard 单独调用也做能力检测', () => {
  const calls = useWx({ clipboard: false });
  const channels = [];
  file.copyToClipboard('content', 'CSV', channel => channels.push(channel));
  assert.deepEqual(channels, [null]);
  assert.ok(calls.toast.some(title => title.includes('不支持剪贴板')));
});

test('我的页备份：走通出口才更新「上次备份」，全链路失败不假装备份过', () => {
  useWx();
  store.reset();
  const okPage = mount('../miniprogram/pages/me/index.js');
  okPage.onLoad();
  assert.equal(okPage.data.backupView.lastBackupText, '尚未备份');
  okPage.backupNow();
  assert.match(okPage.data.backupView.lastBackupText, /^上次备份 \d{2}-\d{2} \d{2}:\d{2}$/, '发送文件成功就要记下备份时间');
  assert.equal(store.backupMeta().lastBackupAt ? true : false, true);
  okPage.onUnload();

  const broken = useWx({ fs: false, share: false, open: false, clipboard: false });
  store.reset();
  const badPage = mount('../miniprogram/pages/me/index.js');
  badPage.onLoad();
  badPage.backupNow();
  assert.equal(badPage.data.backupView.lastBackupText, '尚未备份', '什么都没导出，不能推进备份时间');
  assert.ok(broken.toast.some(title => title.includes('无法导出')));
  badPage.onUnload();
});
