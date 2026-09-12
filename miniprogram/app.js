const { getState } = require('./store/store');

App({
  globalData: {
    get state() { return getState(); }
  },
  onLaunch() { getState(); }
});
