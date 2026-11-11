import { median, sumCurves } from './model.mjs';

export const defaults = ['2.2.6', '2.3.0', '2.3.1', '2.3.2'];
export function parseOptions(args) {
  const options = { versions: [], runs: 3, preset: 'full', local: false, inside: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--local') options.local = true;
    else if (arg === '--inside') options.inside = true;
    else if (arg === '--runs') {
      const n = args[++i];
      if (!/^[1-9]\d*$/.test(n ?? '') || Number(n) > 20) throw Error('--runs must be between 1 and 20');
      options.runs = Number(n);
    } else if (arg === '--preset') {
      options.preset = args[++i];
      if (!['full', 'smoke'].includes(options.preset)) throw Error('--preset must be full or smoke');
    } else if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(arg)) options.versions.push(arg);
    else throw Error(`Unknown argument or non-exact version: ${arg}`);
  }
  if (!options.versions.length) options.versions = [...defaults];
  if (new Set(options.versions).size !== options.versions.length) throw Error('Duplicate versions');
  return options;
}
export function schedule(versions, rounds) {
  return Array.from({ length: rounds }, (_, round) =>
    versions.map((_, i) => ({ version: versions[(i + round) % versions.length], round: round + 1 }))).flat();
}
export function summarizeTarget(worker, timeline, version, manifest) {
  if (worker.lane !== 'release' || worker.snapshotOverheadIncludedInHighWater || worker.runtime.rspack !== version || worker.runtime.binding !== version)
    throw Error('Comparison requires matching, uninstrumented release bindings');
  if (worker.steady.length !== 5 || JSON.stringify(worker.manifest) !== JSON.stringify(manifest))
    throw Error('Incomplete steady window or different generated input');
  const end = worker.steady.at(-1).ms;
  const rss = timeline.rss.filter(s => s.ms <= end && s.rss > 0);
  const v8 = timeline.js.filter(s => s.ms <= end);
  if (!rss.length || !v8.length) throw Error('Missing memory samples');
  const shape = worker.phases.find(s => s.phase === 'processAssets');
  const assets = worker.phases.find(s => s.phase === 'asset-read');
  if (!shape || !assets || !worker.phases.some(s => s.phase === 'done')) throw Error('Missing completed build phases');
  return { rss, v8,
    peakRss: Math.max(...rss.map(s => s.rss)), kernelHighWater: worker.kernelHighWater,
    peakHeap: Math.max(...v8.map(s => s.heapUsed)),
    steadyRss: median(worker.steady.map(s => s.rss)), steadyHeap: median(worker.steady.map(s => s.heapUsed)),
    shape: { modules: shape.modules, chunks: shape.chunks, jsBytes: assets.sizes.js, assetFiles: assets.files },
    runtime: worker.runtime,
  };
}
export function combineTargets(server, client) {
  const rss = sumCurves(server.rss, client.rss);
  const v8 = sumCurves(server.v8, client.v8, 'heapUsed');
  return { rss, v8, peakRss: Math.max(...rss.map(s => s.rss)),
    peakHeap: Math.max(...v8.map(s => s.heapUsed)),
    steadyRss: server.steadyRss + client.steadyRss,
    steadyHeap: server.steadyHeap + client.steadyHeap };
}
export function aggregateRuns(runs, expected) {
  if (runs.length !== expected) throw Error('Incomplete versions must not be ranked');
  const result = {};
  for (const target of ['combined', 'server', 'client']) {
    result[target] = {};
    for (const metric of ['peakRss', 'steadyRss', 'peakHeap', 'steadyHeap']) {
      const values = runs.map(r => r[target][metric]);
      if (values.some(v => !Number.isFinite(v) || v <= 0)) throw Error('Invalid memory observation');
      result[target][metric] = { median: median(values), min: Math.min(...values), max: Math.max(...values), values };
    }
  }
  const center = result.combined.peakRss.median;
  result.representativeRound = runs.reduce((a, b) =>
    Math.abs(b.combined.peakRss - center) < Math.abs(a.combined.peakRss - center) ? b : a).round;
  return result;
}
export function delta(value, baseline) {
  return baseline > 0 ? (value / baseline - 1) * 100 : null;
}
