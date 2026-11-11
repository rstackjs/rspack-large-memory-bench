// One compiler and one measurement lane per fresh process.
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import inspector from 'node:inspector';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../config.mjs';

const [preset, target, lane, out, checkpoint = 'done#1'] = process.argv.slice(2);
if (!global.gc || !['client', 'server'].includes(target)) throw Error('Invalid worker invocation');
process.env.RAYON_NUM_THREADS ??= '6';
process.env.TOKIO_WORKER_THREADS ??= '6';
const require = createRequire(import.meta.url);
const { rspack } = await import('@rspack/core');
let native;
if (lane === 'native') {
  native = require(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
  if (!native.benchProfileStart) throw Error('Binding lacks profiling exports');
  native.benchProfileStart(out);
}
let session;
const post = (method, params = {}) => new Promise((resolve, reject) =>
  session.post(method, params, (err, result) => err ? reject(err) : resolve(result)));
if (lane === 'js-steady') {
  session = new inspector.Session();
  session.connect();
  await post('HeapProfiler.startSampling', {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const startedAt = new Date().toISOString();
const manifest = JSON.parse(fs.readFileSync(`generated-${preset}/manifest.json`));
const phases = [];
const occurrences = new Map();
let origin;
let captured = false;
function sample(phase) {
  const s = { ms: Number(process.hrtime.bigint() - origin) / 1e6, ...process.memoryUsage() };
  if (phase) s.phase = phase;
  process.send({ type: 'memory', sample: s });
  return s;
}
function capture(label) {
  const before = sample('snapshot:before');
  v8.writeHeapSnapshot(path.join(out, `${label}.heapsnapshot`), { exposeInternals: true });
  const after = sample('snapshot:after');
  fs.writeFileSync(path.join(out, `${label}-capture.json`), JSON.stringify({
    checkpoint, before, after, semantics: 'Reachable V8 graph after snapshot-triggered GC; shallow self sizes',
  }, null, 2));
}
function record(_compiler, phase, extra = {}) {
  const occurrence = (occurrences.get(phase) ?? 0) + 1;
  occurrences.set(phase, occurrence);
  const s = { ...sample(phase), ...extra, occurrence };
  phases.push(s);
  if (lane === 'js-peak' && `${phase}#${occurrence}` === checkpoint && !captured) {
    captured = true;
    capture('peak');
  }
}
const c = config(path.resolve(`generated-${preset}`), record, { isolated: true }).find(c => c.name === target);
c.plugins.push({
  apply(compiler) {
    for (const hook of ['beforeCompile', 'make', 'finishMake', 'afterEmit'])
      compiler.hooks[hook].tap('ProfilePhases', () => record(target, hook));
    compiler.hooks.thisCompilation.tap('ProfilePhases', compilation => {
      for (const hook of ['finishModules', 'afterSeal'])
        compilation.hooks[hook].tap('ProfilePhases', () => record(target, hook));
      compilation.hooks.processAssets.tap({ name: 'ProfilePhases', stage: -10000 }, () => record(target, 'processAssets', {
        modules: compilation.modules.size, chunks: compilation.chunks.size,
      }));
    });
  },
});
// The normal benchmark intentionally overlaps two compilers. Isolated mode removes
// that synchronization plugin entirely, so neither compiler waits for its sibling.
const compiler = rspack(c);
origin = process.hrtime.bigint();
process.send({ type: 'begin', origin: origin.toString() });
await new Promise(resolve => process.once('message', resolve));
const timer = setInterval(() => sample(), 50);
let stats;
try {
  record(target, 'start');
  stats = await new Promise((resolve, reject) => compiler.run((e, s) => e ? reject(e) : resolve(s)));
  if (stats.hasErrors()) throw Error(stats.toString({ all: false, errors: true }));
  record(target, 'done');
  await delay(preset === 'smoke' ? 100 : 10000);
  for (let i = 0; i < 4; i++) { global.gc(); await delay(100); }
  const steady = [];
  for (let i = 0; i < 5; i++) {
    record(target, 'steady'); steady.push(phases.at(-1));
    await delay(preset === 'smoke' ? 50 : 1000);
  }
  if (native) {
    native.benchProfileStop();
    native.benchProfileDump(path.join(out, 'steady-native.json'));
  }
  if (session) {
    const { profile } = await post('HeapProfiler.stopSampling');
    fs.writeFileSync(path.join(out, 'allocations.heapprofile'), JSON.stringify(profile));
    session.disconnect();
    capture('steady');
  }
  if (lane === 'js-peak' && !captured) throw Error(`Checkpoint not observed: ${checkpoint}`);
  fs.writeFileSync(path.join(out, 'worker.json'), JSON.stringify({
    target, lane, preset, phases, steady, manifest, startedAt, finishedAt: new Date().toISOString(),
    runtime: { node: process.version, arch: process.arch, platform: process.platform,
      rspack: require('@rspack/core/package.json').version,
      rayon: process.env.RAYON_NUM_THREADS, tokio: process.env.TOKIO_WORKER_THREADS },
    kernelHighWater: process.resourceUsage().maxRSS * 1024,
    snapshotOverheadIncludedInHighWater: lane.startsWith('js-'),
  }, null, 2));
} finally {
  clearInterval(timer);
  native?.benchProfileStop();
  await new Promise((resolve, reject) => compiler.close(e => e ? reject(e) : resolve()));
  process.disconnect();
}
