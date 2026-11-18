#!/usr/bin/env node
'use strict';
/**
 * Prepares what the installers bundle, for one target:
 *   node packaging/prepare.js windows   -> build/stage/windows (the app, node\node.exe, tools\cloudflared.exe)
 *   node packaging/prepare.js mac       -> build/stage/mac (the app) and build/deps/mac (node and cloudflared, both CPUs)
 * Node.js comes from nodejs.org (the newest long-term-support release), checked
 * against its SHASUMS256.txt; cloudflared comes from Cloudflare's GitHub release,
 * checked against GitHub's SHA-256 digest. Nothing unchecked is bundled.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { unzip } = require('../scripts/zip');

const ROOT = path.join(__dirname, '..');
const target = process.argv[2];
if (!['windows', 'mac'].includes(target)) throw new Error('usage: node packaging/prepare.js windows|mac');
const STAGE = path.join(ROOT, 'build', 'stage', target);
const DEPS = path.join(ROOT, 'build', 'deps', target);
const COMMON = ['server.js', 'package.json', 'lib', 'public', 'reporter-mod', 'scripts/setup-address-finder.js'];
const EXTRA = { windows: ['start-remote.cmd', 'desktop/launch.vbs', 'desktop/stop.ps1', 'desktop/icon.ico'], mac: [] };
const SKIP = /(^|[\\/])(tests?|\.git|node_modules)([\\/]|$)/;
// Personal details to keep out of the bundle: this computer's home folder (both slash styles) and
// anything listed in PRIVATE_WORDS (comma-separated). Built at run time so no name is written here.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LEAK = new RegExp(
  [os.homedir(), os.homedir().replace(/\\/g, '/'), os.homedir().replace(/\\/g, '\\\\'), ...(process.env.PRIVATE_WORDS || '').split(',')]
    .map((w) => w.trim())
    .filter((w) => w.length > 3)
    .map(escapeRe)
    .join('|') || '(?!)',
  'i',
);

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const gh = { 'User-Agent': 'claude-usage-monitor-build', Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }) };

async function get(url, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Finds one file in a tar archive by the end of its path (e.g. "bin/node"). */
function untar(tar, suffix) {
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (s, l) => h.subarray(s, s + l).toString('utf8').replace(/\0[\s\S]*$/, '');
    const name = field(345, 155) ? `${field(345, 155)}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    if ((type === '0' || type === '\0') && (name === suffix || name.endsWith(`/${suffix}`))) return Buffer.from(tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${suffix} not found in archive`);
}

async function nodeRelease() {
  const index = JSON.parse(await get('https://nodejs.org/dist/index.json'));
  const lts = index.find((r) => r.lts);
  const sums = (await get(`https://nodejs.org/dist/${lts.version}/SHASUMS256.txt`)).toString();
  const sumOf = (file) => {
    const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${file}`));
    if (!line) throw new Error(`no checksum for ${file}`);
    return line.split(/\s+/)[0];
  };
  return { version: lts.version, sumOf };
}

async function nodeFor(rel, file, pick) {
  const buf = await get(`https://nodejs.org/dist/${rel.version}/${file}`);
  if (sha256(buf) !== rel.sumOf(file)) throw new Error(`checksum mismatch for ${file}`);
  console.log(`  node ${rel.version}: ${file} checked`);
  return pick(buf);
}

async function cloudflaredFor(name, pick) {
  const rel = JSON.parse(await get('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', gh));
  const asset = rel.assets.find((a) => a.name === name);
  if (!asset || !/^sha256:[0-9a-f]{64}$/.test(asset.digest || '')) throw new Error(`no checked ${name}`);
  const buf = await get(asset.browser_download_url, { 'User-Agent': gh['User-Agent'] });
  if (`sha256:${sha256(buf)}` !== asset.digest) throw new Error(`checksum mismatch for ${name}`);
  console.log(`  cloudflared ${rel.tag_name}: ${name} checked`);
  return { bin: pick(buf), version: rel.tag_name };
}

function copy(rel, dest) {
  const src = path.join(ROOT, rel);
  if (SKIP.test(rel)) return;
  if (fs.statSync(src).isDirectory()) {
    for (const f of fs.readdirSync(src)) copy(path.join(rel, f), dest);
    return;
  }
  const to = path.join(dest, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(src, to);
  if (/\.(js|json|cmd|ps1|vbs|html|css|txt|md)$/.test(rel) && LEAK.test(fs.readFileSync(src, 'utf8'))) throw new Error(`personal details in ${rel}`);
}

async function main() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(DEPS, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  fs.mkdirSync(DEPS, { recursive: true });
  for (const rel of [...COMMON, ...EXTRA[target]]) copy(rel, STAGE);
  const links = path.join(__dirname, 'links.json');
  if (fs.existsSync(links)) fs.copyFileSync(links, path.join(STAGE, 'links.json'));

  const rel = await nodeRelease();
  const versions = { node: rel.version };
  if (target === 'windows') {
    const file = `node-${rel.version}-win-x64.zip`;
    const exe = await nodeFor(rel, file, (zipBuf) => unzip(zipBuf).find((e) => e.name.endsWith('/node.exe')).data);
    fs.mkdirSync(path.join(STAGE, 'node'), { recursive: true });
    fs.writeFileSync(path.join(STAGE, 'node', 'node.exe'), exe);
    const cf = await cloudflaredFor('cloudflared-windows-amd64.exe', (b) => b);
    fs.mkdirSync(path.join(STAGE, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(STAGE, 'tools', 'cloudflared.exe'), cf.bin);
    versions.cloudflared = cf.version;
  } else {
    for (const [cpu, nodeCpu, cfCpu] of [['arm64', 'arm64', 'arm64'], ['x64', 'x64', 'amd64']]) {
      const bin = await nodeFor(rel, `node-${rel.version}-darwin-${nodeCpu}.tar.gz`, (b) => untar(zlib.gunzipSync(b), 'bin/node'));
      fs.writeFileSync(path.join(DEPS, `node-${cpu}`), bin, { mode: 0o755 });
      const cf = await cloudflaredFor(`cloudflared-darwin-${cfCpu}.tgz`, (b) => untar(zlib.gunzipSync(b), 'cloudflared'));
      fs.writeFileSync(path.join(DEPS, `cloudflared-${cpu}`), cf.bin, { mode: 0o755 });
      versions.cloudflared = cf.version;
    }
  }
  fs.writeFileSync(path.join(ROOT, 'build', `versions-${target}.json`), JSON.stringify(versions, null, 2));
  console.log(`Prepared ${target}: ${JSON.stringify(versions)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
