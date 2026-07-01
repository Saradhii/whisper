// Default Expo Metro config. The model is downloaded at runtime (not bundled),
// so no special asset handling is required.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
