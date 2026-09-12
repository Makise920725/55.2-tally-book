const { createInitialState } = require('./domain/plan');

App({
  globalData: {
    state: createInitialState()
  }
});
