// Mutes the system's default microphone, so the call app hears nothing while the toggle is on.
const { spawn, execFile } = require('node:child_process');

// Windows: one long-lived PowerShell answers "get"/"toggle" lines, so Add-Type compiles only once.
const WINDOWS_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f1(); int f2(); int f3(); int f4(); int f5(); int f6(); int f7(); int f8(); int f9(); int f10(); int f11();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int f2();
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int f1();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator {}

public static class MicMute {
  static IAudioEndpointVolume Endpoint(int role, out string id) {
    var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice device;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(1, role, out device));
    device.GetId(out id);
    var iid = typeof(IAudioEndpointVolume).GUID;
    object volume;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out volume));
    return (IAudioEndpointVolume)volume;
  }

  public static bool Get() {
    string id;
    bool muted;
    Marshal.ThrowExceptionForHR(Endpoint(0, out id).GetMute(out muted));
    return muted;
  }

  // Applies to the default console and communications mics; call apps usually record from the latter.
  public static bool Toggle() {
    string consoleId, commsId;
    var console = Endpoint(0, out consoleId);
    var comms = Endpoint(2, out commsId);
    bool muted;
    Marshal.ThrowExceptionForHR(console.GetMute(out muted));
    var next = !muted;
    var context = Guid.Empty;
    Marshal.ThrowExceptionForHR(console.SetMute(next, ref context));
    if (commsId != consoleId) Marshal.ThrowExceptionForHR(comms.SetMute(next, ref context));
    return next;
  }
}
'@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $muted = if ($line -eq 'toggle') { [MicMute]::Toggle() } else { [MicMute]::Get() }
    [Console]::Out.WriteLine($(if ($muted) { '1' } else { '0' }))
  } catch {
    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
`;

let helper = null;
let pending = [];
let buffer = '';

function failPending(err) {
  helper = null;
  buffer = '';
  pending.splice(0).forEach(({ reject }) => reject(err));
}

function windowsHelper() {
  if (helper) return helper;
  helper = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')],
    { windowsHide: true }
  );
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const request = pending.shift();
      if (!request) continue;
      if (line.startsWith('ERR')) request.reject(new Error(line.slice(4) || 'mic mute failed'));
      else request.resolve(line === '1');
    }
  });
  helper.on('error', failPending);
  helper.on('exit', () => failPending(new Error('mic mute helper exited')));
  return helper;
}

function windowsCommand(command) {
  return new Promise((resolve, reject) => {
    const child = windowsHelper();
    pending.push({ resolve, reject });
    child.stdin.write(`${command}\n`);
  });
}

// macOS has no input mute switch, so muting sets input volume to 0 and unmuting restores the old level.
let macRestoreVolume = 75;

function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

async function macInputVolume() {
  return Number(await osascript('input volume of (get volume settings)')) || 0;
}

async function getMicMuted() {
  if (process.platform === 'win32') return windowsCommand('get');
  if (process.platform === 'darwin') return (await macInputVolume()) === 0;
  throw new Error('mic mute is not supported on this platform');
}

async function toggleMicMute() {
  if (process.platform === 'win32') return windowsCommand('toggle');
  if (process.platform === 'darwin') {
    const volume = await macInputVolume();
    if (volume > 0) macRestoreVolume = volume;
    await osascript(`set volume input volume ${volume > 0 ? 0 : macRestoreVolume}`);
    return volume > 0;
  }
  throw new Error('mic mute is not supported on this platform');
}

function disposeMicMute() {
  helper?.kill();
}

module.exports = { getMicMuted, toggleMicMute, disposeMicMute };
