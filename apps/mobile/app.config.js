// Push notifications on Android go through Firebase, which needs the project's
// google-services.json at build time. It's kept outside the repository, next to the
// signing key (~/.qr-attendance), or wherever GOOGLE_SERVICES_JSON points. Without it the
// app builds and works; it just doesn't receive push notifications (see docs/DEPLOY.md).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = ({ config }) => {
  const file = process.env.GOOGLE_SERVICES_JSON || path.join(os.homedir(), '.qr-attendance', 'google-services.json');
  if (!fs.existsSync(file)) return config;
  return { ...config, android: { ...config.android, googleServicesFile: file } };
};
