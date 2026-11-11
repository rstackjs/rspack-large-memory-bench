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
  'server 与 client 在全新进程中串行采集。曲线按各自构建开始对齐，较短构建结束后保持最后一个稳态值，再逐时刻相加。叠加包含两份进程运行时；它是独立进程估算，不是原来双 compiler 并行构建的实测峰值。',
  'RSS 曲线来自普通发布绑定，进程外每 20 ms 采样；V8 heapUsed 每 50 ms 及 hook 边界采样。JS 同步阻塞时采样会有空隙，图中保持上次读数，不插造中间数据。VmHWM 用于检查采样遗漏。',
  '稳态指构建完成后空闲、4 次显式 GC、5 个采样点的中位数，此时 compiler 尚未 close。它不是进程退出后的内存，也不是 dev server 重建稳态。',
  'Rust 来自匹配版本的 mimalloc 诊断绑定，64 KiB 独立字节采样，按采样概率反推存活/累计请求字节；大于等于 64 KiB 的分配全收集。数据结构按分配栈归类，是分配来源估计，不是反射遍历或精确 retained size，不含分配器空闲页、栈及外部 mmap。',
  'Rust 峰值快照由独立线程每 50 ms 检查 RSS，在 RSS 比上次快照高 5% 时更新。快照时暂停 Rust 分配/释放以保持索引一致；诊断 RSS 含栈索引和快照开销，不能代替发布版曲线。每行同时给出样本数，稀少样本不宜作小幅差异结论。',
  'JS 峰值快照使用独立重放，在距离普通构建 RSS 峰值最近的 hook 捕获。V8 快照触发 GC，表中是该阶段可达对象的 shallow/self size，包含 V8 native 节点；瞬时垃圾和 ArrayBuffer 外部内存不能据此完整还原。稳态快照来自另一独立重放，避免峰值快照改变稳态。',
  'JS 累计分配位置使用 32 KiB V8 allocation sampling，并保留 minor/major GC 已收集对象；无源码 URL 的内建函数按最近的 JS 调用者列出位置。Rust 累计分配位置为所有采样 alloc/realloc 请求字节，含已经释放的分配；两者都不是当前存活字节。',
  '合计结构表是两个目标各自峰值附近或稳态快照的逐类相加；各自峰值并非同一时刻，也不一定等于叠加曲线峰值时的分布。Rust 和 JS 来自不同诊断重放，不能与 RSS 相减来宣称精确分解。',
];
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
  manifest: read('manifest.json'), nativeBuild: read('native-build.json'), methodology, targets, combined };
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const gib = value => (value / 2 ** 30).toFixed(2);
const mib = value => (value / 2 ** 20).toFixed(2);
function table(rows, { sampled = false, locations = false } = {}) {
  const total = rows.reduce((sum, r) => sum + r.bytes, 0);
  return `<div class="scroll"><table><thead><tr><th>${locations ? '分配函数 / 位置' : '结构 / 分配来源'}</th><th>MiB</th><th>占比</th>${sampled ? '<th>样本数</th>' : ''}</tr></thead><tbody>${rows.slice(0, 25).map(r => `<tr><td><code>${esc((r.type ? r.type + ' / ' : '') + r.name)}</code>${r.location ? `<small>${esc(r.location)}</small>` : ''}</td><td>${mib(r.bytes)}</td><td>${(100 * r.bytes / Math.max(1, total)).toFixed(1)}%</td>${sampled ? `<td>${r.samples.toLocaleString('en')}</td>` : ''}</tr>`).join('')}</tbody></table></div><p class="caption">显示前 25 项；分母为全部 ${rows.length} 项，合计 ${mib(total)} MiB。完整列表见 report.json。</p>`;
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1180 395" role="img" aria-label="server、client、叠加 RSS 与叠加 V8 内存曲线"><style>text{font:12px system-ui;fill:#475569}</style><rect width="1180" height="395" fill="white"/>${grid}${phases}${lines.join('')}<polyline fill="none" stroke="#9333ea" stroke-width="2" stroke-dasharray="6 3" points="${heap}"/><text x="8" y="25">GiB</text><text x="600" y="387" text-anchor="middle">各自构建开始后的秒数</text></svg>`;
}
const svg = chart();
fs.writeFileSync(path.join(out, 'timeline.svg'), svg);
function section(name, data) {
  const aggregate = name === 'combined';
  const title = aggregate ? '两端叠加' : name;
  const nativeLocations = aggregate ? data.nativeLocations : data.native.steady.locations;
  return `<section data-target="${name}" ${aggregate ? '' : 'hidden'}><h2>${title}</h2>${!aggregate ? `<p>普通构建峰值 ${gib(data.release.peak.rss)} GiB · VmHWM ${gib(data.release.kernelHighWater)} GiB · 稳态 RSS ${gib(data.steadyRss)} GiB · 稳态 V8 ${gib(data.steadyHeap)} GiB</p><p>JS 峰值重放 checkpoint：<code>${esc(data.release.checkpoint)}</code>，距普通构建采样峰值 ${(data.release.checkpointGapMs / 1000).toFixed(3)} s；快照前 RSS ${gib(data.js.peak.capture.before.rss)} GiB。Rust 快照前 RSS ${gib(data.native.peak.rssBeforeSnapshot)} GiB / 诊断采样峰值 ${gib(data.nativeSummary.peak.rss)} GiB；存活字节符号覆盖率 ${(data.native.peak.symbolCoverage * 100).toFixed(1)}%。</p>` : '<p>结构表相加的是各自峰值快照；它与上方逐时刻叠加曲线的峰值不是同一个口径。</p>'}
    ${['peak', 'steady'].map(phase => `<h3>${phase === 'peak' ? '峰值附近' : '稳态'} · 主要数据结构</h3><div class="columns"><article><h4>Rust · 存活请求字节估算</h4>${table(data.native[phase].groups, { sampled: true })}</article><article><h4>JS · 可达对象 self size</h4>${table(data.js[phase].groups)}</article></div>`).join('')}
    <h3>累计分配最多的代码位置</h3><p>含已经释放的分配，用于定位分配压力；同一块内存经 realloc 后会记录新的请求大小。</p><div class="columns"><article><h4>Rust · 累计请求字节估算</h4>${table(nativeLocations, { sampled: true, locations: true })}</article><article><h4>JS · V8 累计分配采样</h4>${table(data.jsLocations, { locations: true })}</article></div>
    ${aggregate ? '' : `<details><summary>原始快照和调用栈</summary><ul><li><a href="${name}/js-peak/peak.heapsnapshot">JS 峰值附近 .heapsnapshot</a></li><li><a href="${name}/js-steady/steady.heapsnapshot">JS 稳态 .heapsnapshot</a></li><li><a href="${name}/js-steady/allocations.heapprofile">JS 累计分配 .heapprofile</a></li><li><a href="${name}/native/peak-analysis.json">Rust 峰值分配栈</a></li><li><a href="${name}/native/steady-analysis.json">Rust 稳态 / 累计分配栈</a></li></ul></details>`}</section>`;
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rspack 构建内存报告</title><style>
*{box-sizing:border-box}body{font:15px/1.65 system-ui,sans-serif;margin:0;background:#f3f6fa;color:#172b45}main{max-width:1440px;margin:auto;padding:30px}h1{font-size:32px;margin:0}h2{font-size:24px}h3{margin-top:35px}h4{margin:0 0 10px}.muted,.caption,small{color:#64748b}.caption{font-size:12px}header{margin-bottom:24px}.cards,.columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.cards{grid-template-columns:repeat(3,1fr)}.card,article,.chart,details{background:white;border:1px solid #dae2ec;border-radius:10px;padding:18px}.card b{display:block;font-size:28px}.chart{margin:24px 0}svg{width:100%;height:auto}.legend span{margin-right:20px;white-space:nowrap}.scroll{overflow:auto;max-height:620px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:9px 7px;border-bottom:1px solid #edf0f4;text-align:right;vertical-align:top}th{position:sticky;top:0;background:#f8fafc}th:first-child,td:first-child{text-align:left}td:first-child{max-width:420px;overflow-wrap:anywhere}small{display:block}code{font:12px ui-monospace,monospace}select{padding:8px 16px;font:inherit;border:1px solid #94a3b8;border-radius:6px}details{margin:22px 0}summary{cursor:pointer;font-weight:600}li{margin:8px 0}a{color:#2563eb}section[hidden]{display:none}@media(max-width:850px){main{padding:16px}.columns,.cards{grid-template-columns:1fr}}
</style><main><header><p class="muted">RSPACK LARGE MEMORY BENCH</p><h1>构建内存报告</h1><p>独立采集 server / client，再叠加；发布构建曲线与诊断快照分开呈现。</p><small>Rspack ${esc(server.runtime.rspack)} · Node ${esc(server.runtime.node)} · ${esc(server.runtime.platform)}/${esc(server.runtime.arch)} · ${esc(report.generatedAt)}</small></header>
<div class="cards"><div class="card">对齐叠加 RSS 峰值（估算）<b>${gib(combined.peak.rss)} GiB</b><small>发生在各自开始后 ${(combined.peak.ms / 1000).toFixed(2)} s</small></div><div class="card">稳态 RSS 合计<b>${gib(combined.steadyRss)} GiB</b><small>GC 后、compiler close 前</small></div><div class="card">稳态 V8 heapUsed 合计<b>${gib(combined.steadyHeap)} GiB</b><small>运行时计数；不等于堆快照 self size</small></div></div>
<div class="chart"><div class="legend"><span style="color:${colors[0]}">● server RSS</span><span style="color:${colors[1]}">● client RSS</span><span style="color:${colors[2]}">● 叠加 RSS</span><span style="color:#9333ea">┄ 叠加 V8 heapUsed</span></div>${svg}</div>
<details open><summary>测量口径与边界</summary><ol>${methodology.map(s => `<li>${esc(s)}</li>`).join('')}</ol></details>
<label>查看：<select id="target"><option value="combined">两端叠加</option><option value="server">server</option><option value="client">client</option></select></label>
${section('combined', combined)}${section('server', server)}${section('client', client)}
<p><a href="report.json">完整数据 JSON</a> · <a href="report.md">Markdown 报告</a> · <a href="timeline.svg">曲线 SVG</a></p></main><script>document.querySelector('#target').addEventListener('change',e=>document.querySelectorAll('[data-target]').forEach(s=>s.hidden=s.dataset.target!==e.target.value));</script></html>`;
fs.writeFileSync(path.join(out, 'report.html'), html);
const mdTable = rows => '| 结构 / 分配位置 | MiB |\n| --- | ---: |\n' + rows.slice(0, 15).map(r => {
  const label = (r.type ? r.type + ' / ' : '') + r.name + (r.location ? ' @ ' + r.location : '');
  return `| <code>${esc(label).replaceAll('|', '&#124;').replaceAll('\n', ' ')}</code> | ${mib(r.bytes)} |`;
}).join('\n');
let md = `# Rspack 构建内存报告\n\n独立串行采集 server 和 client，按构建开始对齐叠加。\n\n![内存曲线](timeline.svg)\n\n对齐叠加 RSS 峰值：${gib(combined.peak.rss)} GiB；稳态 RSS 合计：${gib(combined.steadyRss)} GiB；稳态 V8 合计：${gib(combined.steadyHeap)} GiB。\n\n## 口径\n\n${methodology.map(s => '- ' + s).join('\n')}\n`;
for (const [name, data] of [['combined', combined], ...Object.entries(targets)]) {
  md += `\n## ${name}\n`;
  for (const phase of ['peak', 'steady']) {
    md += `\n### ${phase} Rust\n\n${mdTable(data.native[phase].groups)}\n\n### ${phase} JS\n\n${mdTable(data.js[phase].groups)}\n`;
  }
  md += `\n### Rust 累计分配位置\n\n${mdTable(name === 'combined' ? data.nativeLocations : data.native.steady.locations)}\n\n### JS 累计分配位置\n\n${mdTable(data.jsLocations)}\n`;
}
fs.writeFileSync(path.join(out, 'report.md'), md);
console.log(`Wrote ${out}/report.html`);
