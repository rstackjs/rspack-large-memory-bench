import fs from 'node:fs';
import { channel } from 'node:diagnostics_channel';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { config } from './config.mjs';

process.env.RAYON_NUM_THREADS ??= '6';
process.env.TOKIO_WORKER_THREADS ??= '6';
const { rspack } = await import('@rspack/core');
const preset = process.argv[2] ?? 'full';
if (!['full', 'smoke'].includes(preset) || !global.gc)
  throw Error('use npm run bench -- [full|smoke]');
const root = path.resolve('generated-' + preset);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
const samples = [];
const phases = channel('synthetic-memory.phase');
function record(compiler, phase, extra = {}) {
  const sample = {
    compiler,
    phase,
    ms: Math.round(performance.now()),
    ...process.memoryUsage(),
    ...extra,
  };
  samples.push(sample);
  phases.publish(sample);
  console.log(compiler, phase, Math.round(sample.rss / 2 ** 20), 'MiB RSS');
}
const configs = config(root, record);
for (const c of configs)
  c.plugins.push({
    apply(compiler) {
      compiler.hooks.finishMake.tap('Sample', () =>
        record(c.name, 'finishMake'),
      );
      compiler.hooks.thisCompilation.tap('Sample', (compilation) => {
        compilation.hooks.processAssets.tap(
          { name: 'Sample', stage: -10000 },
          () =>
            record(c.name, 'processAssets', {
              modules: compilation.modules.size,
              chunks: compilation.chunks.size,
            }),
        );
      });
    },
  });
const compiler = rspack(configs);
try {
  const stats = await new Promise((resolve, reject) =>
    compiler.run((err, s) => (err ? reject(err) : resolve(s))),
  );
  if (stats.hasErrors())
    throw Error(stats.toString({ all: false, errors: true }));
  record('both', 'done');
  await delay(preset === 'smoke' ? 20 : 10000);
  for (let i = 0; i < 4; i++) {
    global.gc();
    await delay(100);
  }
  for (let i = 0; i < 5; i++) {
    record('both', 'steady');
    await delay(preset === 'smoke' ? 10 : 3000);
  }
  // Node reports ru_maxrss in KiB on Linux and macOS.
  const result = {
    manifest,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      rayon: process.env.RAYON_NUM_THREADS,
      tokio: process.env.TOKIO_WORKER_THREADS,
      rspack: compiler.compilers[0].webpack.rspackVersion,
    },
    peakRss: process.resourceUsage().maxRSS * 1024,
    samples,
  };
  fs.mkdirSync('results', { recursive: true });
  fs.writeFileSync(
    'results/' + preset + '.json',
    JSON.stringify(result, null, 2) + '\n',
  );
} finally {
  await new Promise((res, rej) => compiler.close((e) => (e ? rej(e) : res())));
}
