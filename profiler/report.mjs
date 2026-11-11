import fs from 'node:fs';
import path from 'node:path';
import { median, sumCurves, mergeGroups, jsAllocations } from './model.mjs';

const out = path.resolve(process.argv[2] ?? 'results/profile-full');
const read = file => JSON.parse(fs.readFileSync(path.join(out, file)));
const targets = {};
for (const target of ['server', 'client']) {
  const release = read(`${target}/release/worker.json`);
  const summary = read(`${target}/release/summary.json`);
  const timeline = read(`${target}/release/timeline.json`);
  const native = Object.fromEntries(['peak', 'steady'].map(phase => {
    const data = read(`${target}/native/${phase}-analysis.json`);
    const { sites, ...compact } = data;
    return [phase, compact];
  }));
  const js = Object.fromEntries(['peak', 'steady'].map(phase => [phase, {
    ...read(`${target}/js-${phase}/heap.json`),
    capture: read(`${target}/js-${phase}/${phase}-capture.json`),
  }]));
  const nativeSummary = read(`${target}/native/summary.json`);
  targets[target] = {
    runtime: release.runtime, manifest: release.manifest, release: summary,
    rss: timeline.rss.filter(s => s.ms <= summary.end),
    v8: timeline.js.filter(s => s.ms <= summary.end),
    phases: release.phases,
    steadyRss: median(release.steady.map(s => s.rss)),
    steadyHeap: median(release.steady.map(s => s.heapUsed)),
    native, js, nativeSummary,
    jsLocations: jsAllocations(read(`${target}/js-steady/allocations.heapprofile`)),
  };
}
const [server, client] = [targets.server, targets.client];
const rss = sumCurves(server.rss, client.rss);
const v8 = sumCurves(server.v8, client.v8, 'heapUsed');
const combined = {
  rss, v8, peak: rss.reduce((a, b) => b.rss > a.rss ? b : a),
  steadyRss: server.steadyRss + client.steadyRss,
  steadyHeap: server.steadyHeap + client.steadyHeap,
  js: Object.fromEntries(['peak', 'steady'].map(phase => [phase, {
    groups: mergeGroups(server.js[phase].groups, client.js[phase].groups),
    totalSelfBytes: server.js[phase].totalSelfBytes + client.js[phase].totalSelfBytes,
  }])),
  native: Object.fromEntries(['peak', 'steady'].map(phase => [phase, {
    groups: mergeGroups(server.native[phase].groups, client.native[phase].groups),
    totalLiveBytes: server.native[phase].totalLiveBytes + client.native[phase].totalLiveBytes,
  }])),
  jsLocations: mergeGroups(server.jsLocations, client.jsLocations),
  nativeLocations: mergeGroups(server.native.steady.locations, client.native.steady.locations),
};
const methodology = [
  "Server and client are measured sequentially in fresh processes. Curves are aligned at build start and added point by point, holding the final steady reading after the shorter run ends. The sum includes two process runtimes: it is an independent-process estimate, not the measured peak of the original concurrent dual-compiler build.",
  "RSS is sampled externally every 20 ms with the release binding. V8 heapUsed is sampled every 50 ms and at hook boundaries. Synchronous JS work leaves sampling gaps; charts hold the previous reading without inventing intermediate samples. VmHWM helps identify peaks missed by sampling.",
  "Steady state is the median of five samples after the completed build idles and runs four explicit GCs, while the compiler remains alive. It is neither post-exit memory nor a dev-server rebuild measurement.",
  "Rust measurements use a matching mimalloc diagnostic binding with independent byte sampling at 64 KiB. Live and cumulative requested bytes are estimated using inverse sampling probabilities; allocations of at least 64 KiB are always recorded. Structures are grouped by allocation stack: these are provenance estimates, not reflection-based measurements or exact retained sizes. Allocator free pages, stacks and external mmap allocations are excluded.",
  "An independent thread checks diagnostic RSS every 50 ms and updates the peak snapshot when RSS rises by 5%. Rust allocation/free operations pause during capture to keep the index consistent. Diagnostic RSS includes stack-index and snapshot overhead and does not replace the release curve. Tables include sample counts; sparse samples cannot establish small differences.",
  "The JS peak snapshot is captured in an independent replay at the hook nearest the release RSS peak. V8 snapshots trigger GC, so tables show shallow/self sizes of reachable objects, including V8 native nodes. They cannot fully reconstruct transient garbage or external ArrayBuffer storage. A separate replay captures steady state to avoid perturbation from the peak snapshot.",
  "JS cumulative allocation sites use 32 KiB V8 sampling, including objects collected by minor and major GC. Built-ins without source URLs are attributed to the nearest JS caller. Rust cumulative allocations include sampled alloc/realloc requests, including allocations already freed. Neither total represents currently live bytes.",
  "Combined structure tables add categories from the two targets at their own near-peak or steady-state snapshots. Independent peaks need not coincide with each other or with the combined curve peak. Rust and JS snapshots come from separate diagnostic replays and cannot be subtracted from RSS to claim an exact decomposition."
];
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
  manifest: read('manifest.json'), nativeBuild: read('native-build.json'), methodology, targets, combined };
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const gib = value => (value / 2 ** 30).toFixed(2);
const mib = value => (value / 2 ** 20).toFixed(2);
function table(rows, { sampled = false, locations = false } = {}) {
  const total = rows.reduce((sum, r) => sum + r.bytes, 0);
  return `<div class="scroll"><table><thead><tr><th>${locations ? 'Allocation function / location' : 'Structure / allocation provenance'}</th><th>MiB</th><th>Share</th>${sampled ? '<th>Samples</th>' : ''}</tr></thead><tbody>${rows.slice(0, 25).map(r => `<tr><td><code>${esc((r.type ? r.type + ' / ' : '') + r.name)}</code>${r.location ? `<small>${esc(r.location)}</small>` : ''}</td><td>${mib(r.bytes)}</td><td>${(100 * r.bytes / Math.max(1, total)).toFixed(1)}%</td>${sampled ? `<td>${r.samples.toLocaleString('en')}</td>` : ''}</tr>`).join('')}</tbody></table></div><p class="caption">Top 25 entries shown. Percentages use all ${rows.length} entries, totaling ${mib(total)} MiB. See report.json for the complete list.</p>`;
}
const colors = ['#2563eb', '#0f766e', '#e67e22'];
function chart() {
  const curves = [server.rss, client.rss, combined.rss];
  const xmax = Math.max(...curves.map(c => c.at(-1).ms));
  const ymax = Math.max(...curves.flatMap(c => c.map(s => s.rss))) * 1.08;
  const x = ms => 65 + ms / xmax * 1070;
  const y = bytes => 340 - bytes / ymax * 285;
  const lines = curves.map((curve, i) => {
    // Reduce only for drawing; retain every point in report.json.
    const bucket = new Map();
    for (const s of curve) { const n = Math.floor(x(s.ms)); const prev = bucket.get(n); if (!prev || s.rss > prev.rss) bucket.set(n, s); }
    return `<polyline fill="none" stroke="${colors[i]}" stroke-width="2.5" points="${[...bucket.values()].map(s => `${x(s.ms).toFixed(1)},${y(s.rss).toFixed(1)}`).join(' ')}"/>`;
  });
  const heap = combined.v8.flatMap((s, i) => [
    `${x(s.ms).toFixed(1)},${y(combined.v8[Math.max(0, i - 1)].heapUsed).toFixed(1)}`,
    `${x(s.ms).toFixed(1)},${y(s.heapUsed).toFixed(1)}`,
  ]).join(' ');
  const grid = Array.from({ length: 6 }, (_, i) => {
    const bytes = ymax * i / 5, ms = xmax * i / 5;
    return `<path d="M65 ${y(bytes)}H1135" stroke="#e2e8f0"/><text x="56" y="${y(bytes) + 4}" text-anchor="end">${gib(bytes)}</text><text x="${x(ms)}" y="363" text-anchor="middle">${(ms / 1000).toFixed(1)}</text>`;
  }).join('');
  const phases = ['server', 'client'].map((name, i) => {
    const done = targets[name].phases.find(s => s.phase === 'done');
    return `<path d="M${x(done.ms)} 55V340" stroke="${colors[i]}" stroke-dasharray="3 4"/><text x="${x(done.ms)}" y="${25 + i * 17}" fill="${colors[i]}" text-anchor="middle">${name} done</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1180 395" role="img" aria-label="Server, client and combined RSS, with combined V8 heap usage"><style>text{font:12px system-ui;fill:#475569}</style><rect width="1180" height="395" fill="white"/>${grid}${phases}${lines.join('')}<polyline fill="none" stroke="#9333ea" stroke-width="2" stroke-dasharray="6 3" points="${heap}"/><text x="8" y="25">GiB</text><text x="600" y="387" text-anchor="middle">Seconds since each build started</text></svg>`;
}
const svg = chart();
fs.writeFileSync(path.join(out, 'timeline.svg'), svg);
function section(name, data) {
  const aggregate = name === 'combined';
  const title = aggregate ? 'Combined targets' : name;
  const nativeLocations = aggregate ? data.nativeLocations : data.native.steady.locations;
  return `<section data-target="${name}" ${aggregate ? '' : 'hidden'}><h2>${title}</h2>${!aggregate ? `<p>Release peak RSS ${gib(data.release.peak.rss)} GiB · VmHWM ${gib(data.release.kernelHighWater)} GiB · Steady RSS ${gib(data.steadyRss)} GiB · Steady V8 ${gib(data.steadyHeap)} GiB</p><p>JS peak replay checkpoint: <code>${esc(data.release.checkpoint)}</code>, offset from the sampled release peak: ${(data.release.checkpointGapMs / 1000).toFixed(3)} s; RSS before snapshot: ${gib(data.js.peak.capture.before.rss)} GiB. Rust RSS before snapshot: ${gib(data.native.peak.rssBeforeSnapshot)} GiB / sampled diagnostic peak: ${gib(data.nativeSummary.peak.rss)} GiB; symbol coverage of live bytes: ${(data.native.peak.symbolCoverage * 100).toFixed(1)}%.</p>` : '<p>Structure tables add independent peak snapshots; they do not describe the distribution at the peak of the combined curve above.</p>'}
    ${['peak', 'steady'].map(phase => `<h3>${phase === 'peak' ? 'Near peak' : 'Steady state'} · Major data structures</h3><div class="columns"><article><h4>Rust · Estimated live requested bytes</h4>${table(data.native[phase].groups, { sampled: true })}</article><article><h4>JS · Reachable object self size</h4>${table(data.js[phase].groups)}</article></div>`).join('')}
    <h3>Top cumulative allocation sites</h3><p>Includes freed allocations to help locate allocation pressure. Each realloc records the newly requested size.</p><div class="columns"><article><h4>Rust · Estimated cumulative requested bytes</h4>${table(nativeLocations, { sampled: true, locations: true })}</article><article><h4>JS · V8 cumulative allocation samples</h4>${table(data.jsLocations, { locations: true })}</article></div>
    ${aggregate ? '' : `<details><summary>Raw snapshots and allocation stacks</summary><ul><li><a href="${name}/js-peak/peak.heapsnapshot">JS near-peak .heapsnapshot</a></li><li><a href="${name}/js-steady/steady.heapsnapshot">JS steady-state .heapsnapshot</a></li><li><a href="${name}/js-steady/allocations.heapprofile">JS cumulative allocations .heapprofile</a></li><li><a href="${name}/native/peak-analysis.json">Rust peak allocation stacks</a></li><li><a href="${name}/native/steady-analysis.json">Rust steady-state / cumulative allocation stacks</a></li></ul></details>`}</section>`;
}
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rspack Build memory report</title><style>
*{box-sizing:border-box}body{font:15px/1.65 system-ui,sans-serif;margin:0;background:#f3f6fa;color:#172b45}main{max-width:1440px;margin:auto;padding:30px}h1{font-size:32px;margin:0}h2{font-size:24px}h3{margin-top:35px}h4{margin:0 0 10px}.muted,.caption,small{color:#64748b}.caption{font-size:12px}header{margin-bottom:24px}.cards,.columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.cards{grid-template-columns:repeat(3,1fr)}.card,article,.chart,details{background:white;border:1px solid #dae2ec;border-radius:10px;padding:18px}.card b{display:block;font-size:28px}.chart{margin:24px 0}svg{width:100%;height:auto}.legend span{margin-right:20px;white-space:nowrap}.scroll{overflow:auto;max-height:620px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:9px 7px;border-bottom:1px solid #edf0f4;text-align:right;vertical-align:top}th{position:sticky;top:0;background:#f8fafc}th:first-child,td:first-child{text-align:left}td:first-child{max-width:420px;overflow-wrap:anywhere}small{display:block}code{font:12px ui-monospace,monospace}select{padding:8px 16px;font:inherit;border:1px solid #94a3b8;border-radius:6px}details{margin:22px 0}summary{cursor:pointer;font-weight:600}li{margin:8px 0}a{color:#2563eb}section[hidden]{display:none}@media(max-width:850px){main{padding:16px}.columns,.cards{grid-template-columns:1fr}}
</style><main><header><p class="muted">RSPACK LARGE MEMORY BENCH</p><h1>Build memory report</h1><p>Server and client are collected separately, then combined. Release memory curves and diagnostic snapshots are reported separately.</p><small>Rspack ${esc(server.runtime.rspack)} · Node ${esc(server.runtime.node)} · ${esc(server.runtime.platform)}/${esc(server.runtime.arch)} · ${esc(report.generatedAt)}</small></header>
<div class="cards"><div class="card">Aligned combined peak RSS (estimate)<b>${gib(combined.peak.rss)} GiB</b><small>At ${(combined.peak.ms / 1000).toFixed(2)} s after each build started</small></div><div class="card">Combined steady RSS<b>${gib(combined.steadyRss)} GiB</b><small>After GC, before compiler.close()</small></div><div class="card">Combined steady V8 heapUsed<b>${gib(combined.steadyHeap)} GiB</b><small>Runtime counters, not heap-snapshot self sizes</small></div></div>
<div class="chart"><div class="legend"><span style="color:${colors[0]}">● server RSS</span><span style="color:${colors[1]}">● client RSS</span><span style="color:${colors[2]}">● Combined RSS</span><span style="color:#9333ea">┄ Combined V8 heapUsed</span></div>${svg}</div>
<details open><summary>Methodology and limitations</summary><ol>${methodology.map(s => `<li>${esc(s)}</li>`).join('')}</ol></details>
<label>View: <select id="target"><option value="combined">Combined targets</option><option value="server">server</option><option value="client">client</option></select></label>
${section('combined', combined)}${section('server', server)}${section('client', client)}
<p><a href="report.json">Complete JSON data</a> · <a href="report.md">Markdown report</a> · <a href="timeline.svg">Curve SVG</a></p></main><script>document.querySelector('#target').addEventListener('change',e=>document.querySelectorAll('[data-target]').forEach(s=>s.hidden=s.dataset.target!==e.target.value));</script></html>`;
fs.writeFileSync(path.join(out, 'report.html'), html);
const mdTable = rows => '| Structure / allocation site | MiB |\n| --- | ---: |\n' + rows.slice(0, 15).map(r => {
  const label = (r.type ? r.type + ' / ' : '') + r.name + (r.location ? ' @ ' + r.location : '');
  return `| <code>${esc(label).replaceAll('|', '&#124;').replaceAll('\n', ' ')}</code> | ${mib(r.bytes)} |`;
}).join('\n');
let md = `# Rspack Build memory report\n\nServer and client are measured sequentially, then aligned at build start and added.\n\n![Memory curves](timeline.svg)\n\nAligned combined peak RSS: ${gib(combined.peak.rss)} GiB; Combined steady RSS: ${gib(combined.steadyRss)} GiB; Combined steady V8: ${gib(combined.steadyHeap)} GiB.\n\n## Methodology\n\n${methodology.map(s => '- ' + s).join('\n')}\n`;
for (const [name, data] of [['combined', combined], ...Object.entries(targets)]) {
  md += `\n## ${name}\n`;
  for (const phase of ['peak', 'steady']) {
    md += `\n### ${phase} Rust\n\n${mdTable(data.native[phase].groups)}\n\n### ${phase} JS\n\n${mdTable(data.js[phase].groups)}\n`;
  }
  md += `\n### Rust cumulative allocation sites\n\n${mdTable(name === 'combined' ? data.nativeLocations : data.native.steady.locations)}\n\n### JS cumulative allocation sites\n\n${mdTable(data.jsLocations)}\n`;
}
fs.writeFileSync(path.join(out, 'report.md'), md);
console.log(`Wrote ${out}/report.html`);
