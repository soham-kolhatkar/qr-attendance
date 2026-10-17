const fs = require('node:fs');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

/**
 * Testing builds only (EXPO_PUBLIC_ALLOW_SERVER_CHANGE=true): lets the app talk to a
 * server on the phone's own "localhost" over plain HTTP — a laptop's server reached
 * through `adb reverse` over USB. Every other address still requires HTTPS. In normal
 * builds this removes the exception again, so it never reaches students.
 */
const FILE = 'network_security_config.xml';
const CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
`;

module.exports = function withLocalTestServer(config) {
  const enabled = process.env.EXPO_PUBLIC_ALLOW_SERVER_CHANGE === 'true';

  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      const file = path.join(dir, FILE);
      if (enabled) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, CONFIG);
      } else {
        fs.rmSync(file, { force: true });
      }
      return cfg;
    },
  ]);

  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) {
      if (enabled) app.$['android:networkSecurityConfig'] = `@xml/${FILE.replace('.xml', '')}`;
      else delete app.$['android:networkSecurityConfig'];
    }
    return cfg;
  });
};
