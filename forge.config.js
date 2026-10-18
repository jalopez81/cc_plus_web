module.exports = {
  packagerConfig: {
    name: 'Mac Live Captioner',
    appBundleId: 'com.maclivecaptioner.app',
    asar: true,
    extendInfo: {
      NSAudioCaptureUsageDescription:
        'Mac Live Captioner listens to system audio to generate live captions.',
    },
  },
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
  ],
};
