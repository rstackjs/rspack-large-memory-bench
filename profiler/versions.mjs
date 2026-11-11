#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { run, launchDocker } from './environment.mjs';
import { collect } from './collect.mjs';
import { parseOptions, schedule } from './versions-model.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run compare:versions -- [2.2.6 2.3.0 2.3.1 2.3.2] [--runs 3] [--preset full|smoke] [--local]\nExact npm versions only. Default: release bindings, three rounds, native Linux Docker.');
  process.exit(0);
}
const options = parseOptions(args);
if (!options.local && !options.inside) {
  await launchDocker(root, ['compare', ...args]);
  const latest = JSON.parse(fs.readFileSync(`results/compare-${options.preset}/latest.json`));
  console.log(`Report: ${path.join(root, latest.report)}`);
  process.exit(0);
}
if (process.platform !== 'linux') throw Error('--local requires Linux; omit it to use Docker');
// Compare native releases even if a local caller normally forces the WASI fallback.
delete process.env.NAPI_RS_FORCE_WASI;
const cache = path.resolve('.profile-cache');
fs.mkdirSync(cache, { recursive: true });
const lock = path.join(cache, 'collect.lock');
try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
catch (e) {
  if (e.code !== 'EEXIST') throw e;
  throw Error('A collector holds .profile-cache/collect.lock. Remove a stale lock only after checking that no collection is running.');
}
process.on('exit', () => fs.rmSync(lock, { force: true }));
const id = new Date().toISOString().replace(/[:.]/g, '-');
const parent = path.resolve(`results/compare-${options.preset}`);
const out = path.join(parent, id);
fs.mkdirSync(out, { recursive: true });
const read = file => JSON.parse(fs.readFileSync(file));
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const state = { schemaVersion: 1, createdAt: new Date().toISOString(), options,
  baseline: options.versions[0], status: 'preparing', order: schedule(options.versions, options.runs),
  inputs: Object.fromEntries(['generate.mjs', 'config.mjs', 'plugins.mjs', 'mapped-input.cjs', 'profiler/worker.mjs', 'profiler/collect.mjs'].map(f => [f, digest(f)])),
  versions: Object.fromEntries(options.versions.map(v => [v, { status: 'pending', rounds: [] }])),
};
const save = () => fs.writeFileSync(path.join(out, 'comparison.json'), JSON.stringify(state, null, 2));
save();
// Install everything before measuring. Each version keeps its own lockfile and
// platform binding; neither the repository lockfile nor root node_modules change.
const roots = new Map();
for (const version of options.versions) {
  const entry = state.versions[version];
  const directory = path.join(cache, 'versions', `${process.platform}-${process.arch}`, version);
  const logDir = path.join(out, version);
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(logDir, { recursive: true });
  const marker = path.join(directory, 'installed.json');
  try {
    const installed = fs.existsSync(marker) ? read(marker) : {};
    const packageFile = path.join(directory, 'node_modules/@rspack/core/package.json');
    const bindingFile = path.join(directory, 'node_modules/@rspack/binding/package.json');
    if (installed.version !== version || !fs.existsSync(packageFile) || read(packageFile).version !== version ||
        !fs.existsSync(bindingFile) || read(bindingFile).version !== version || !fs.existsSync(path.join(directory, 'package-lock.json'))) {
      console.log(`[${version}] installing public release`);
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ private: true, dependencies: { '@rspack/core': version } }, null, 2));
      const log = fs.openSync(path.join(logDir, 'install.log'), 'w');
      try { await run('npm', [fs.existsSync(path.join(directory, 'package-lock.json')) ? 'ci' : 'install', '--prefix', directory,
        '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'], { stdio: ['ignore', log, log] }); }
      finally { fs.closeSync(log); }
      if (read(packageFile).version !== version || read(bindingFile).version !== version) throw Error('Installed versions do not match the request');
      fs.writeFileSync(marker, JSON.stringify({ version }));
    }
    entry.lockSha256 = digest(path.join(directory, 'package-lock.json'));
    fs.copyFileSync(path.join(directory, 'package-lock.json'), path.join(logDir, 'package-lock.json'));
    roots.set(version, directory);
    entry.status = 'ready';
  } catch (e) { entry.status = 'failed'; entry.error = `Installation: ${e.message}; see ${version}/install.log`; }
  save();
}
await run(process.execPath, ['generate.mjs', options.preset]);
state.manifest = read(`generated-${options.preset}/manifest.json`);
state.status = 'collecting'; save();
for (const { version, round } of state.order) {
  const entry = state.versions[version];
  if (entry.status === 'failed') continue;
  console.log(`[${version}] round ${round}/${options.runs}`);
  try {
    const startedAt = new Date().toISOString();
    for (const target of ['server', 'client']) {
      console.log(`  ${target}: release memory`);
      await collect({ preset: options.preset, target, lane: 'release',
        out: path.join(out, version, `run-${round}`, target), coreRoot: roots.get(version), expectedVersion: version });
    }
    entry.rounds.push({ round, startedAt, finishedAt: new Date().toISOString() });
    entry.status = entry.rounds.length === options.runs ? 'complete' : 'collecting';
  } catch (e) { entry.status = 'failed'; entry.error = `Round ${round}: ${e.message.replaceAll(out, '.')}`; }
  save();
}
state.status = options.versions.every(v => state.versions[v].status === 'complete') ? 'complete' : 'partial';
state.finishedAt = new Date().toISOString(); save();
await run(process.execPath, ['profiler/versions-report.mjs', out]);
fs.writeFileSync(path.join(parent, 'latest.json'), JSON.stringify({ report: path.relative(root, path.join(out, 'report.html')), status: state.status }, null, 2));
console.log(`Report: ${path.join(out, 'report.html')}`);
if (state.status !== 'complete') process.exitCode = 1;
