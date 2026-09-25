const { getState } = require('./store/store');

// 这里以前挂着一颗 tab 栏红点（今日 tab 上的「①」），提示「今天还有几件事没做完」。
// 但它只会给一个数字，用户根本看不出在提示什么，还容易和「生活费待登记」之类的卡片混起来。
// 现在改成今日页顶部那张待办清单（`pages/today.pendingTodos`）：逐条写清还差哪一步，
// 做完一件少一件。App 这层不再碰任何界面元素。
App({
  globalData: {
    get state() { return getState(); }
  },
  onLaunch() { getState(); }
});
