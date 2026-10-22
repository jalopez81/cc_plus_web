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
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'win32'] },
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
  ],
};
