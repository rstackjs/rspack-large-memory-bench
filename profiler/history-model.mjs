import { median } from './model.mjs';

export const stable = version => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
export function compareVersions(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export function mergeReport(history, report, metadata, seriesId, source) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(seriesId)) throw Error('Invalid series id');
  if (report.schemaVersion !== 1 || report.preset !== 'full' || report.rounds !== 3 || !report.environment || !report.inputs)
    throw Error('History requires a full, three-round release report');
  const next = structuredClone(history);
  const protocol = { preset: report.preset, rounds: report.rounds, environment: report.environment,
    manifest: report.manifest, inputs: report.inputs };
  let series = next.series.find(s => s.id === seriesId);
  if (series && canonical(series.protocol) !== canonical(protocol))
    throw Error('Measurement protocol changed; use a new series id instead of mixing results');
  const candidates = report.versions.filter(r => r.status === 'complete' && !series?.releases.some(s => s.version === r.version));
  if (!candidates.length) return next;
  if (!series) { series = { id: seriesId, protocol: structuredClone(protocol), releases: [] }; next.series.push(series); }
  for (const row of candidates) {
    if (!stable(row.version) || compareVersions(row.version, history.minimumVersion) < 0 ||
        !metadata.versions.includes(row.version) || !Number.isFinite(Date.parse(metadata.time[row.version])))
      throw Error('History only accepts published stable versions within its coverage');
    const metrics = {};
    for (const target of ['combined', 'server', 'client']) {
      metrics[target] = {};
      for (const metric of ['peakRss', 'steadyRss', 'peakHeap', 'steadyHeap']) {
        const values = row.aggregates?.[target]?.[metric]?.values;
        if (!Array.isArray(values) || values.length !== 3 || values.some(v => !Number.isFinite(v) || v <= 0))
          throw Error('Incomplete or invalid round measurements');
        metrics[target][metric] = { median: median(values), min: Math.min(...values), max: Math.max(...values), values: [...values] };
      }
    }
    if (row.runs?.length !== 3 || !/^[a-f0-9]{64}$/.test(row.lockSha256)) throw Error('Missing measurement provenance');
    series.releases.push({ version: row.version, publishedAt: metadata.time[row.version], measuredAt: report.createdAt,
      source: structuredClone(source), lockSha256: row.lockSha256, metrics,
      shapes: row.runs.map(run => ({ round: run.round, server: structuredClone(run.server.shape), client: structuredClone(run.client.shape) })) });
  }
  series.releases.sort((a,b) => compareVersions(a.version,b.version));
  return next;
}
const gib = n => (n / 2**30).toFixed(3);
export function renderHistory(history) {
  let text = '## Release memory history\n\n';
  text += `Stable releases from **${history.minimumVersion}** onward. Each entry preserves the first successful full run of three rounds. Values are GiB; peak ranges are the observed min–max, not confidence intervals. Server/client are measured serially and their curves are aligned before taking the combined peak. Steady state is measured after GC with the compiler alive.\n\n`;
  text += 'Different runner environments or benchmark revisions use separate series; do not compare their numbers directly. Machine-readable measurements, per-target metrics, input hashes and every round’s values are in [history/releases.json](history/releases.json).\n';
  for (const series of history.series) {
    const p=series.protocol, e=p.environment;
    text += `\n### ${series.id}\n\n${e.platform}/${e.arch}, Node ${e.node}, Rayon ${e.rayon}, Tokio ${e.tokio}; ${p.manifest.modules.toLocaleString('en')} generated modules, ${p.rounds} rounds.\n\n`;
    text += '| Rspack | Measured (UTC) | Combined peak RSS (range) | Combined steady RSS | Combined steady V8 | Evidence |\n';
    text += '| --- | --- | ---: | ---: | ---: | --- |\n';
    for (const row of series.releases) {
      const m=row.metrics, peak=m.combined.peakRss;
      const evidence=`[Report](reports/memory/${series.id}/${row.version}/report.md)`;
      text += `| ${row.version} | ${row.measuredAt.slice(0,10)} | ${gib(peak.median)} (${gib(peak.min)}–${gib(peak.max)}) | ${gib(m.combined.steadyRss.median)} | ${gib(m.combined.steadyHeap.median)} | ${evidence} |\n`;
    }
  }
  return text;
}
export function updateReadme(readme, history) {
  const start='<!-- release-memory-history:start -->', end='<!-- release-memory-history:end -->';
  if (readme.split(start).length !== 2 || readme.split(end).length !== 2 || readme.indexOf(start)>readme.indexOf(end))
    throw Error('README must contain exactly one history marker pair');
  return readme.slice(0,readme.indexOf(start)) + start+'\n'+renderHistory(history)+'\n'+end + readme.slice(readme.indexOf(end)+end.length);
}
