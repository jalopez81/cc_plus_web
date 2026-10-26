module.exports = {
  packagerConfig: {
    name: 'Live Captioner',
    appBundleId: 'com.livecaptioner.app',
    asar: true,
    icon: 'assets/icon',
    extendInfo: {
      NSAudioCaptureUsageDescription: 'Live Captioner listens to system audio to generate live captions.',
      NSMicrophoneUsageDescription: 'Live Captioner watches your headset mic level to show whether it is muted.',
    },
  },
  makers: [
    // Windows installer: Setup.exe installs per user (no admin), adds Start menu and desktop shortcuts,
    // and shows up in Settings › Apps for uninstalling.
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'live_captioner',
        setupExe: 'LiveCaptionerSetup.exe',
        setupIcon: 'assets/icon.ico',
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'win32'] },
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
  ],
};
