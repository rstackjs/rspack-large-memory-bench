#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, launchDocker } from './environment.mjs';
import { createHash } from 'node:crypto';
import { collect } from './collect.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const args = process.argv.slice(2);
const preset = args.find(a => !a.startsWith('--')) ?? 'full';
if (args.includes('--help')) {
  console.log('npm run profile -- [full|smoke] [--local]\nDefault: native-architecture Docker. --local: Linux with Node, Rust, Python 3 and binutils already installed.');
  process.exit(0);
}
if (!['full', 'smoke'].includes(preset) || args.some(a => a.startsWith('--') && !['--local', '--inside'].includes(a)))
  throw Error('Use npm run profile -- [full|smoke] [--local]');
const cache = path.join(root, '.profile-cache');
fs.mkdirSync(cache, { recursive: true });
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (!args.includes('--local') && !args.includes('--inside')) {
  await launchDocker(root, [preset]);
  console.log(`Report: ${path.join(root, 'results/profile-' + preset, 'report.html')}`);
  process.exit(0);
}
if (process.platform !== 'linux') throw Error('--local requires Linux; use the default Docker command on macOS/Windows');
const lock = path.join(cache, 'collect.lock');
try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  throw Error('Another profile run holds .profile-cache/collect.lock. After an interrupted run, remove that file only when no collector is running.');
}
process.on('exit', () => fs.rmSync(lock, { force: true }));
if (args.includes('--inside')) {
  const marker = path.join(cache, 'npm-installed');
  const key = `${process.arch}:${digest('package-lock.json')}`;
  if (!fs.existsSync('node_modules/@rspack/core/package.json') || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== key) {
    await run('npm', ['ci', '--no-audit', '--no-fund']);
    fs.writeFileSync(marker, key);
  }
}
const binding = path.join(cache, 'rspack-profile.node');
const buildMeta = path.join(cache, 'native-build.json');
const buildHash = digest('profiler/native/build.py');
const allocatorHash = digest('profiler/native/allocator.rs');
let meta = fs.existsSync(buildMeta) ? JSON.parse(fs.readFileSync(buildMeta)) : {};
if (!fs.existsSync(binding) || meta.instrumentationSha256 !== allocatorHash || meta.buildScriptSha256 !== buildHash || meta.arch !== process.arch || meta.platform !== process.platform) {
  console.log('Building the diagnostic Rspack binding (cached after the first run)…');
  const log = fs.openSync(path.join(cache, 'build.log'), 'w');
  try { await run('python3', ['profiler/native/build.py'], { stdio: ['ignore', log, log] }); }
  catch (e) { throw Error(`${e.message}; see .profile-cache/build.log`); }
  finally { fs.closeSync(log); }
  meta = JSON.parse(fs.readFileSync(buildMeta));
  meta.buildScriptSha256 = buildHash;
  fs.writeFileSync(buildMeta, JSON.stringify(meta, null, 2));
}
if (meta.rspack !== JSON.parse(fs.readFileSync('node_modules/@rspack/core/package.json')).version)
  throw Error('Diagnostic binding and npm Rspack versions differ');
const binaryHash = createHash('sha256');
for await (const chunk of fs.createReadStream(binding)) binaryHash.update(chunk);
if (binaryHash.digest('hex') !== meta.sha256) throw Error('Cached diagnostic binding checksum differs; remove .profile-cache/rspack-profile.node and retry.');
if (!fs.existsSync(`generated-${preset}/manifest.json`)) await run(process.execPath, ['generate.mjs', preset]);
const out = path.resolve(`results/profile-${preset}`);
fs.mkdirSync(out, { recursive: true });
// Remove stale reports first; failed/partial runs must not appear to be complete.
for (const file of ['report.html', 'report.md', 'report.json']) fs.rmSync(path.join(out, file), { force: true });
fs.copyFileSync(buildMeta, path.join(out, 'native-build.json'));
fs.copyFileSync(`generated-${preset}/manifest.json`, path.join(out, 'manifest.json'));
for (const target of ['server', 'client']) {
  const dest = lane => path.join(out, target, lane);
  // Never run measurement children in parallel, including across compiler targets.
  console.log(`[${target}] release timeline`);
  const release = await collect({ preset, target, lane: 'release', out: dest('release') });
  console.log(`[${target}] Rust allocation snapshots`);
  await collect({ preset, target, lane: 'native', out: dest('native'), binding });
  for (const phase of ['peak', 'steady'])
    await run('python3', ['profiler/native/analyze.py', path.join(dest('native'), `${phase}-native.json`), binding,
      path.join(dest('native'), `${phase}-analysis.json`)]);
  console.log(`[${target}] JS peak checkpoint: ${release.checkpoint}`);
  await collect({ preset, target, lane: 'js-peak', out: dest('js-peak'), checkpoint: release.checkpoint });
  await run('python3', ['profiler/heap.py', path.join(dest('js-peak'), 'peak.heapsnapshot'), path.join(dest('js-peak'), 'heap.json')]);
  console.log(`[${target}] JS steady snapshot and cumulative allocation sampling`);
  await collect({ preset, target, lane: 'js-steady', out: dest('js-steady') });
  await run('python3', ['profiler/heap.py', path.join(dest('js-steady'), 'steady.heapsnapshot'), path.join(dest('js-steady'), 'heap.json')]);
}
await run(process.execPath, ['profiler/report.mjs', out]);
console.log(`Report: ${path.join(out, 'report.html')}`);
