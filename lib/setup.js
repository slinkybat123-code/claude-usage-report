'use strict';
/** Small helpers for the installers, kept here so they can be tested on any OS. */

const LAUNCH_LABEL = 'dev.usagemonitor.claude';

/** Pulls one file (by its base name) out of an uncompressed tar archive, or returns null. */
function untarFile(tar, baseName) {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0[\s\S]*$/, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const full = prefix ? `${prefix}/${name}` : name;
    const dataStart = off + 512;
    if ((type === '0' || type === '\0') && full.split('/').pop() === baseName) return Buffer.from(tar.subarray(dataStart, dataStart + size));
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A macOS LaunchAgent that starts the monitor (with its tunnel, no sign-in) each time you log in. */
function launchAgentPlist({ node, root, log }) {
  const args = [node, `${root}/server.js`, '--tunnel', 'cloudflare', '--no-sign-in'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

module.exports = { untarFile, launchAgentPlist, LAUNCH_LABEL };
