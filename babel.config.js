// Reanimated's Babel plugin MUST be the last entry in the plugin list. Without
// this file Reanimated does nothing at all — no error, no warning, just an app
// where none of the motion spec happens.
//
// Offramp draws its play surface with Skia rather than animated views, but
// Reanimated still drives the UI-thread clock the render loop reads from, and
// the screen-level transitions outside the canvas.
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-reanimated/plugin'],
  };
};
