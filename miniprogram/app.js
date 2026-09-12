const { getState } = require('./store/store');

App({
  globalData: {
    get state() { return getState(); }
  },
  onLaunch() { getState(); },
  onShow() {
    const state = getState();
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (state.config.startDate <= date && !(state.daySlots[date] && state.daySlots[date].closed)) wx.setTabBarBadge({ index: 0, text: '1' });
    else wx.removeTabBarBadge({ index: 0 });
  }
});
