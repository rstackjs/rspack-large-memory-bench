// Compare one complete run, or medians of independently launched processes.
import fs from 'node:fs';

const baseline = JSON.parse(
  fs.readFileSync(new URL('./baseline.json', import.meta.url)),
);
const paths = process.argv.slice(2);
const flag = paths.indexOf('--shape');
let shape;
if (flag >= 0) {
  const [, file] = paths.splice(flag, 2);
  shape = JSON.parse(fs.readFileSync(file));
}
const runs = (paths.length ? paths : ['results/full.json']).map((file) =>
  JSON.parse(fs.readFileSync(file)),
);
const median = (values) => {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
};
const gib = 2 ** 30;
const steady = (run, key) =>
  median(run.samples.filter((s) => s.phase === 'steady').map((s) => s[key])) /
  gib;
const get = (run, target, phase) => {
  const s = run.samples.find((s) => s.compiler === target && s.phase === phase);
  if (!s) throw Error('Missing sample: ' + target + '/' + phase);
  return s;
};
for (const r of runs) {
  if (
    r.manifest.preset !== 'full' ||
    r.samples.filter((s) => s.phase === 'steady').length !== 5
  )
    throw Error('Expected a completed full-size run.');
  if (get(r, 'server', 'emit-read').ms > get(r, 'client', 'processAssets').ms) {
    throw Error('Expected the server asset-read window before client seal.');
  }
  if (
    JSON.stringify(r.manifest) !== JSON.stringify(runs[0].manifest) ||
    JSON.stringify(r.runtime) !== JSON.stringify(runs[0].runtime)
  )
    throw Error(
      'Compare medians only within the same runtime and generated workload.',
    );
}
const rows = [
  ['Peak RSS, GiB', baseline.peakRssGiB, 0.2, (r) => r.peakRss / gib],
  [
    'Pre-close RSS after GC, GiB',
    baseline.steadyRssGiB,
    0.2,
    (r) => steady(r, 'rss'),
  ],
  [
    'Pre-close V8 used after GC, GiB',
    baseline.steadyHeapGiB,
    0.25,
    (r) => steady(r, 'heapUsed'),
  ],
  // Sampled in the asset hooks; this may differ from the RSS high-water point.
  [
    'Asset-window V8 used, GiB',
    baseline.assetHeapGiB,
    0.25,
    (r) =>
      Math.max(
        ...r.samples
          .filter((s) => ['asset-read', 'emit-read'].includes(s.phase))
          .map((s) => s.heapUsed),
      ) / gib,
  ],
  [
    'Client chunks',
    baseline.client.chunks,
    0.15,
    (r) => get(r, 'client', 'processAssets').chunks,
  ],
  [
    'Server chunks',
    baseline.server.chunks,
    0.15,
    (r) => get(r, 'server', 'processAssets').chunks,
  ],
  [
    'Client JS, MiB',
    baseline.client.jsMiB,
    0.2,
    (r) => get(r, 'client', 'asset-read').sizes.js / 2 ** 20,
  ],
  [
    'Server JS, MiB',
    baseline.server.jsMiB,
    0.2,
    (r) => get(r, 'server', 'asset-read').sizes.js / 2 ** 20,
  ],
];
if (shape) {
  for (const [key, target] of [
    ['client', 'Client'],
    ['server', 'Server'],
  ]) {
    const { unique, occurrences, mapMiB } = baseline[key];
    const s = shape[key];
    if (
      Math.abs(
        s.sizes.js.bytes / get(runs[0], key, 'asset-read').sizes.js - 1,
      ) > 0.005
    ) {
      throw Error('Shape and build byte totals disagree: ' + key);
    }
    rows.push(
      [target + ' mapped sources', unique, 0.25, () => s.distinctMappedSources],
      [
        target + ' source occurrences',
        occurrences,
        0.25,
        () => s.mappedOccurrences,
      ],
      [
        target + ' JS maps, MiB',
        mapMiB,
        0.25,
        () => s.sizes.jsMap.bytes / 2 ** 20,
      ],
    );
  }
}
const report = rows.map(([metric, target, tolerance, read]) => {
  const actual = median(runs.map(read));
  const error = actual / target - 1;
  return {
    metric,
    target,
    actual: +actual.toFixed(3),
    delta: (100 * error).toFixed(1) + '%',
    band: '±' + Math.round(100 * tolerance) + '%',
    pass: Number.isFinite(error) && Math.abs(error) <= tolerance,
  };
});
console.table(report);
if (report.some((row) => !row.pass)) process.exitCode = 1;
