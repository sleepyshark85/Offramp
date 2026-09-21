// Offramp's Babel config.
//
// `react-native-reanimated/plugin` USED to be the only entry here, with a comment claiming
// Reanimated "drives the UI-thread clock the render loop reads from". Nothing imported it and
// the claim was false: the loop is `requestAnimationFrame` (src/ui/useGame.js) and every
// in-canvas animation phase derives from `currentTick - eventTick` (ui.md §9, AC-505).
// Round 7 decided Reanimated out of the project — everything inside the play surface is
// forbidden from wall-clock animation by AC-505, and what is left outside the canvas is six
// one-shot transitions and one opacity pulse, none of them gesture-driven — so the dependency,
// the plugin entry and the comment are all gone (ui.md §9).
//
// `react-native-gesture-handler` SOFT-requires Reanimated and continues without it; it does
// not list it as a peer dependency. The E2E suite is what confirms that, because every tap in
// it goes through RNGH.
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
