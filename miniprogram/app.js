const { getState } = require('./store/store');
const { todayKey } = require('./domain/calendar');
const { isPlanActive } = require('./domain/plan');

App({
  globalData: {
    get state() { return getState(); }
  },
  onLaunch() { getState(); },
  onShow() {
    this.refreshBadge();
  },
  refreshBadge() {
    const state = getState();
    const date = todayKey();
    if (isPlanActive(date, state.config.startDate, state.config.deadline) && !(state.daySlots[date] && state.daySlots[date].closed)) wx.setTabBarBadge({ index: 0, text: '1', fail: () => {} });
    else wx.removeTabBarBadge({ index: 0, fail: () => {} });
  }
});
