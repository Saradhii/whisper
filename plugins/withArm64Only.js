// Local Expo config plugin: build an arm64-v8a-only APK. Every modern Android
// phone is arm64-v8a; dropping armeabi-v7a / x86 / x86_64 roughly halves the
// APK (which carries native libs for llama.cpp, whisper.cpp, sherpa-onnx, etc.).
// Applied during prebuild so it survives `expo prebuild --clean`.
const { withAppBuildGradle, withGradleProperties } = require('@expo/config-plugins');

const ABI = 'arm64-v8a';

function setGradleProperty(config) {
  return withGradleProperties(config, (cfg) => {
    const props = cfg.modResults;
    const existing = props.find(
      (p) => p.type === 'property' && p.key === 'reactNativeArchitectures',
    );
    if (existing) existing.value = ABI;
    else props.push({ type: 'property', key: 'reactNativeArchitectures', value: ABI });
    return cfg;
  });
}

function setAbiFilters(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (!gradle.includes('abiFilters')) {
      // Inject an ndk abiFilters block right after defaultConfig opens, so the
      // final packaged native libs are filtered to arm64 regardless of what the
      // prebuilt third-party AARs contain.
      gradle = gradle.replace(
        /defaultConfig\s*\{/,
        `defaultConfig {\n        ndk {\n            abiFilters "${ABI}"\n        }`,
      );
      cfg.modResults.contents = gradle;
    }
    return cfg;
  });
}

module.exports = function withArm64Only(config) {
  return setAbiFilters(setGradleProperty(config));
};
