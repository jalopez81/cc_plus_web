// macOS 14.2+ silently delivers a dead audio stream unless the host app's
// Info.plist declares NSAudioCaptureUsageDescription. Packaged builds get it via
// forge.config.js; this patches the dev Electron.app used by `npm start`.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') process.exit(0);

const plist = path.join(
  __dirname,
  '..',
  'node_modules/electron/dist/Electron.app/Contents/Info.plist'
);
if (!fs.existsSync(plist)) {
  try {
    execFileSync(process.execPath, [require.resolve('electron/cli.js'), '--version'], {
      stdio: 'ignore',
    });
  } catch {}
}
if (!fs.existsSync(plist)) process.exit(0);

const KEY = 'NSAudioCaptureUsageDescription';
const VALUE = 'Mac Live Captioner listens to system audio to generate live captions.';

try {
  const current = execFileSync('plutil', ['-extract', KEY, 'raw', plist], {
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim();
  if (current === VALUE) process.exit(0);
} catch {}

try {
  execFileSync('plutil', ['-replace', KEY, '-string', VALUE, plist]);
  // Editing Info.plist invalidates the bundle signature; re-sign ad hoc so it still launches.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', path.resolve(plist, '../..')], {
    stdio: 'ignore',
  });
  console.log(`[patch-dev-plist] Added ${KEY} to dev Electron.app`);
} catch (err) {
  console.warn(`[patch-dev-plist] Could not patch Info.plist: ${err.message}`);
}
