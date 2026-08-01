// Local Expo config plugin: fix the MMKVCore pod failing to compile on iOS.
//
// MMKVCore arrives transitively — react-native-sherpa-onnx depends on
// @kesha-antonov/react-native-background-downloader, which depends on MMKV.
// Its secure_wipe() helper (Core/aes/AESCrypt.cpp) takes the C11 Annex K path
// on Apple platforms and calls memset_s(). Apple's SDK only declares memset_s
// behind `#if defined(__STDC_WANT_LIB_EXT1__) && __STDC_WANT_LIB_EXT1__ >= 1`
// (see usr/include/_string.h), so without that macro the pod fails with
// "use of undeclared identifier 'memset_s'". The symbol itself has shipped in
// libSystem since iOS 7, so defining the macro is all that's needed.
//
// Applied during prebuild so it survives `expo prebuild --clean`.
const { withPodfile } = require('@expo/config-plugins');

const DEFINE = '__STDC_WANT_LIB_EXT1__=1';

const SNIPPET = `
    # Declare C11 Annex K (memset_s) for MMKVCore — see plugins/withMmkvSecureWipeFix.js
    installer.pods_project.targets.each do |target|
      if target.name == 'MMKVCore'
        target.build_configurations.each do |build_config|
          defs = build_config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] || ['$(inherited)']
          defs = [defs] if defs.is_a?(String)
          defs << '${DEFINE}' unless defs.include?('${DEFINE}')
          build_config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] = defs
        end
      end
    end
`;

module.exports = function withMmkvSecureWipeFix(config) {
  return withPodfile(config, (cfg) => {
    const contents = cfg.modResults.contents;
    // Idempotent: prebuild without --clean re-runs mods over the existing Podfile.
    if (contents.includes(DEFINE)) return cfg;

    const anchor = /post_install do \|installer\|\n/;
    if (!anchor.test(contents)) {
      throw new Error(
        'withMmkvSecureWipeFix: no `post_install do |installer|` block found in the Podfile.',
      );
    }
    cfg.modResults.contents = contents.replace(anchor, (match) => match + SNIPPET);
    return cfg;
  });
};
