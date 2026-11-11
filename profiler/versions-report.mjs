import fs from 'node:fs';
import path from 'node:path';
import { summarizeTarget, combineTargets, aggregateRuns, delta } from './versions-model.mjs';

if (!process.argv[2]) throw Error('Pass the comparison run directory');
const out = path.resolve(process.argv[2]);
const read = file => JSON.parse(fs.readFileSync(path.join(out, file)));
const state = read('comparison.json');
const reportTitle = state.options.versions.length === 1 ? `Rspack ${state.options.versions[0]} memory report` : 'Rspack version memory comparison';
const versions = [];
let environment;
for (const version of state.options.versions) {
  const entry = state.versions[version];
  if (entry.status !== 'complete') { versions.push({ version, status: entry.status, error: entry.error ?? 'Collection incomplete' }); continue; }
  const runs = entry.rounds.map(({ round }) => {
    const data = { round };
    for (const target of ['server', 'client']) {
      const prefix = `${version}/run-${round}/${target}`;
      data[target] = summarizeTarget(read(`${prefix}/worker.json`), read(`${prefix}/timeline.json`), version, state.manifest);
      const runtime = data[target].runtime;
      const signature = JSON.stringify(Object.fromEntries(['node', 'platform', 'arch', 'rayon', 'tokio'].map(key => [key, runtime[key]])));
      if (environment && environment !== signature) throw Error('Node/platform/worker settings differ between measured processes');
      environment = signature;
    }
    data.combined = combineTargets(data.server, data.client);
    return data;
  });
  const aggregates = aggregateRuns(runs, state.options.runs);
  const representative = runs.find(r => r.round === aggregates.representativeRound);
  versions.push({ version, status: 'complete', lockSha256: entry.lockSha256, aggregates, representative, runs });
}
const baseline = versions.length > 1 ? versions.find(v => v.version === state.baseline && v.status === 'complete') : undefined;
for (const row of versions.filter(v => v.status === 'complete')) {
  row.deltaPercent = Object.fromEntries(['peakRss', 'steadyRss', 'peakHeap', 'steadyHeap'].map(metric => [metric,
    delta(row.aggregates.combined[metric].median, baseline?.aggregates.combined[metric].median)]));
}
const warnings = [];
for (const row of versions.filter(v => v.status === 'complete')) {
  for (const target of ['server', 'client']) {
    const shapes = row.runs.map(r => JSON.stringify(r[target].shape));
    if (new Set(shapes).size > 1) warnings.push(`${row.version} ${target} output shape changed between rounds; inspect each round in the JSON report.`);
    if (baseline) {
      const current = row.runs[0][target].shape;
      const previous = baseline.runs[0][target].shape;
      const labels = { modules: 'Modules', chunks: 'Chunks', jsBytes: 'JS bytes', assetFiles: 'Assets' };
      const changes = Object.keys(labels).filter(key => current[key] !== previous[key])
        .map(key => `${labels[key]} ${previous[key].toLocaleString('en')} → ${current[key].toLocaleString('en')}`);
      if (changes.length) warnings.push(`${row.version} ${target} vs ${state.baseline}: ${changes.join('; ')} (round 1).`);
    }
  }
}
const report = { schemaVersion: 1, createdAt: state.createdAt, status: state.status,
  baseline: state.baseline, preset: state.options.preset, rounds: state.options.runs,
  manifest: state.manifest, inputs: state.inputs, order: state.order,
  environment: environment ? JSON.parse(environment) : null, warnings, versions };
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const gib = n => (n / 2 ** 30).toFixed(3);
const percent = n => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const complete = versions.filter(v => v.status === 'complete');
const environmentText = report.environment ? `${report.environment.node} · ${report.environment.platform}/${report.environment.arch} · Rayon ${report.environment.rayon} / Tokio ${report.environment.tokio}` : 'No valid measurements';
const colors = ['#2563eb', '#0f766e', '#e67e22', '#9333ea', '#dc2626', '#475569'];
const methods = [
  `Each version uses its own published npm core and release binding, without a diagnostic binding or heap snapshots. Each version runs ${state.options.runs} rounds. All versions, rounds and server/client processes run sequentially; version order rotates each round, and dependency installation finishes before measurement.`,
  "All versions share one generated input, configuration, plugins, Node version and worker counts. The report records the generator manifest, input SHA-256 hashes, actual core/binding versions and separate dependency lockfiles. Repository dependencies remain unchanged. JavaScript byte counts are read before the asset plugin appends comments.",
  "For each round, server/client release RSS curves are aligned at build start and added before taking the combined peak. The shorter run holds its final steady reading. This estimate includes two process runtimes; it is neither the measured concurrent dual-compiler peak nor the sum of independent peaks.",
  "Tables show the median and min–max range across rounds. Steady state is the median of five samples after idle time and four explicit GCs, before compiler.close(). RSS is sampled externally every 20 ms; V8 is sampled every 50 ms and at hook boundaries. Synchronous JS work leaves sampling gaps.",
  "Curves show the actual round whose combined RSS peak is nearest the median, not a pointwise median curve. V8 values are heapUsed. RSS minus V8 is not Rust live memory. Data structures and allocation sites require a separate diagnostic report.",
  state.options.versions.length === 1 ? 'This report covers one version, so cross-version deltas are unavailable. Interpret readings together with their round-to-round ranges.' : `Deltas are relative to the first requested version, ${state.baseline}. Failed versions or incomplete rounds are excluded rather than reported as zero. Consider variation and output size when interpreting changes; a single round is only a quick check.`,
];
function chart(target, metric, name) {
  if (!complete.length) return '';
  const field = metric === 'rss' ? 'rss' : 'heapUsed';
  const series = complete.map(v => v.representative[target][metric === 'rss' ? 'rss' : 'v8']);
  const xmax = Math.max(...series.map(c => c.at(-1).ms));
  const ymax = Math.max(...series.flatMap(c => c.map(s => s[field]))) * 1.08;
  const x = ms => 65 + ms / Math.max(1, xmax) * 1070;
  const y = bytes => 310 - bytes / Math.max(1, ymax) * 255;
  const grid = Array.from({ length: 6 }, (_, i) => `<path d="M65 ${y(ymax*i/5)}H1135" stroke="#e2e8f0"/><text x="56" y="${y(ymax*i/5)+4}" text-anchor="end">${gib(ymax*i/5)}</text><text x="${x(xmax*i/5)}" y="334" text-anchor="middle">${(xmax*i/5000).toFixed(1)}</text>`).join('');
  const lines = series.map((curve, i) => {
    const buckets = new Map();
    for (const s of curve) { const k = Math.floor(x(s.ms)); if (!buckets.has(k) || s[field] > buckets.get(k)[field]) buckets.set(k, s); }
    const points = [...buckets.values()];
    return `<polyline fill="none" stroke="${colors[i%colors.length]}" stroke-width="2.5" points="${points.flatMap((s,j) => [`${x(s.ms)},${y(points[Math.max(0,j-1)][field])}`,`${x(s.ms)},${y(s[field])}`]).join(' ')}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1180 368" role="img" aria-label="${esc(name)}"><style>text{font:12px system-ui;fill:#475569}</style><rect width="1180" height="368" fill="white"/><text x="12" y="25">GiB</text>${grid}${lines}<text x="590" y="360" text-anchor="middle">Seconds since build start</text></svg>`;
}
function table(target) {
  return `<div class="scroll"><table><thead><tr><th>Version</th><th>Peak RSS GiB</th><th>Steady RSS GiB</th><th>Steady V8 GiB</th><th>Peak RSS Δ</th><th>Steady RSS Δ</th></tr></thead><tbody>${versions.map(row => {
    if (row.status !== 'complete') return `<tr><td>${esc(row.version)}</td><td colspan="5" class="failed">Incomplete: ${esc(row.error)}</td></tr>`;
    const data = row.aggregates[target];
    const cell = metric => `<td><b>${gib(data[metric].median)}</b><small>${gib(data[metric].min)} – ${gib(data[metric].max)}</small></td>`;
    return `<tr><td>${esc(row.version)}</td>${cell('peakRss')}${cell('steadyRss')}${cell('steadyHeap')}<td>${percent(delta(data.peakRss.median, baseline?.aggregates[target].peakRss.median))}</td><td>${percent(delta(data.steadyRss.median, baseline?.aggregates[target].steadyRss.median))}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
const legends = complete.map((v,i) => `<span style="color:${colors[i%colors.length]}">● ${esc(v.version)} · Round ${v.aggregates.representativeRound}</span>`).join(' ');
const shapes = complete.flatMap(v => ['server','client'].map(t => ({ version:v.version, target:t, ...v.representative[t].shape, hwm: v.representative[t].kernelHighWater })));
const shapeTable = `<div class="scroll"><table><thead><tr><th>Version</th><th>Target</th><th>Modules</th><th>Chunks</th><th>JS MiB</th><th>Assets</th><th>Representative VmHWM GiB</th></tr></thead><tbody>${shapes.map(r => `<tr><td>${esc(r.version)}</td><td>${r.target}</td><td>${r.modules}</td><td>${r.chunks}</td><td>${(r.jsBytes/2**20).toFixed(1)}</td><td>${r.assetFiles}</td><td>${gib(r.hwm)}</td></tr>`).join('')}</tbody></table></div>`;
const rssSvg = chart('combined','rss','Combined RSS curves by version');
fs.writeFileSync(path.join(out,'timeline.svg'),rssSvg || '<svg xmlns="http://www.w3.org/2000/svg"/>');
let html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(reportTitle)}</title><style>body{font:15px/1.65 system-ui,sans-serif;background:#f3f6fa;color:#172b45;margin:0}main{max-width:1280px;padding:30px;margin:auto}h1{font-size:32px;margin-bottom:8px}h2{margin-top:30px}article,details{background:white;border:1px solid #dae2ec;border-radius:10px;padding:20px;margin:18px 0}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:12px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}small{display:block;color:#64748b;font-size:12px}.failed{color:#b91c1c;white-space:normal;text-align:left}.legend span{margin-right:20px}svg{width:100%;height:auto}summary{cursor:pointer;font-weight:600}li{margin:8px 0}a{color:#2563eb}select{font:inherit;padding:7px 12px}section[hidden]{display:none}</style><main><h1>${esc(reportTitle)}</h1><p>${esc(state.options.preset)} · ${state.manifest.modules.toLocaleString('en')} generated modules · ${state.options.runs} rounds per version${state.options.versions.length > 1 ? ' · Baseline ' + esc(state.baseline) : ''}</p><small>${esc(environmentText)} · ${esc(state.createdAt)}</small><p>Each cell shows the median, with the observed min–max range below. Positive deltas indicate more memory; negative deltas indicate less.</p><label>View: <select id="target"><option value="combined">Combined targets (estimate)</option><option value="server">server</option><option value="client">client</option></select></label>`;
for (const target of ['combined','server','client']) html += `<section data-target="${target}" ${target==='combined'?'':'hidden'}><h2>${target==='combined'?'Combined targets':target}</h2><article>${table(target)}</article><article><h3>RSS curves</h3><div class="legend">${legends}</div>${chart(target,'rss',`${target} RSS`)}</article><details><summary>V8 heapUsed curves</summary>${chart(target,'v8',`${target} V8`)}</details></section>`;
html += `${warnings.length?`<article><h2>Output changes</h2><ul>${warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></article>`:''}<details><summary>Output size and kernel high-water marks</summary>${shapeTable}</details><details><summary>Methodology and reproduction data</summary><ol>${methods.map(m=>`<li>${esc(m)}</li>`).join('')}</ol><p><a href="comparison.json">Collection plan and input hashes</a> · <a href="report.json">Complete results</a> · <a href="report.csv">CSV</a> · <a href="report.md">Markdown</a></p></details></main><script>document.querySelector('#target').addEventListener('change',e=>document.querySelectorAll('[data-target]').forEach(s=>s.hidden=s.dataset.target!==e.target.value));</script></html>`;
fs.writeFileSync(path.join(out,'report.html'),html);
const csvMetrics = { peakRss: 'peak_rss', steadyRss: 'steady_rss', peakHeap: 'peak_heap', steadyHeap: 'steady_heap' };
const csv = [['version','status','target','runs',
  ...Object.values(csvMetrics).flatMap(name => [`${name}_gib`, `${name}_min_gib`, `${name}_max_gib`]),
  'peak_rss_delta_percent','steady_rss_delta_percent']];
for (const row of versions) {
  if (row.status!=='complete') { csv.push([row.version,row.status,...Array(csv[0].length-2).fill('')]); continue; }
  for (const target of ['combined','server','client']) {
    const d=row.aggregates[target];
    csv.push([row.version,row.status,target,state.options.runs,
      ...Object.keys(csvMetrics).flatMap(metric => [d[metric].median,d[metric].min,d[metric].max].map(gib)),
      delta(d.peakRss.median,baseline?.aggregates[target].peakRss.median)??'',delta(d.steadyRss.median,baseline?.aggregates[target].steadyRss.median)??'']);
  }
}
fs.writeFileSync(path.join(out,'report.csv'),csv.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\n')+'\n');
let md=`# ${reportTitle}\n\n${state.options.preset}, ${state.options.runs} rounds per version${state.options.versions.length > 1 ? ', baseline ' + state.baseline : ''}. Values are medians; ranges show the observed min–max across rounds.\n\n${environmentText} · ${state.manifest.modules} generated modules · ${state.createdAt}.\n\n![Comparison curves](timeline.svg)\n`;
for (const target of ['combined','server','client']) {
  md+=`\n## ${target}\n\n| Version | Peak RSS GiB (range) | Steady RSS GiB | Steady V8 GiB | Peak Δ | Steady Δ |\n| --- | ---: | ---: | ---: | ---: | ---: |\n`;
  for (const row of versions) {
    if(row.status!=='complete'){md+=`| ${row.version} | Incomplete | — | — | — | — |\n`;continue;}
    const d=row.aggregates[target];
    md+=`| ${row.version} | ${gib(d.peakRss.median)} (${gib(d.peakRss.min)}–${gib(d.peakRss.max)}) | ${gib(d.steadyRss.median)} | ${gib(d.steadyHeap.median)} | ${percent(delta(d.peakRss.median,baseline?.aggregates[target].peakRss.median))} | ${percent(delta(d.steadyRss.median,baseline?.aggregates[target].steadyRss.median))} |\n`;
  }
}
md+=`\n## Methodology\n\n${methods.map(m=>'- '+m).join('\n')}\n`;
if(warnings.length)md+=`\n## Output changes\n\n${warnings.map(w=>'- '+w).join('\n')}\n`;
fs.writeFileSync(path.join(out,'report.md'),md);
console.log(`Wrote ${out}/report.html`);
