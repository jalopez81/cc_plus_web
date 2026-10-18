module.exports = {
  packagerConfig: {
    name: 'Live Captioner',
    appBundleId: 'com.livecaptioner.app',
    asar: true,
    extendInfo: {
      NSAudioCaptureUsageDescription: 'Live Captioner listens to system audio to generate live captions.',
    },
  },
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'win32'] },
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
  ],
};
