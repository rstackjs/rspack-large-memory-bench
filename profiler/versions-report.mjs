import fs from 'node:fs';
import path from 'node:path';
import { summarizeTarget, combineTargets, aggregateRuns, delta } from './versions-model.mjs';

if (!process.argv[2]) throw Error('Pass the comparison run directory');
const out = path.resolve(process.argv[2]);
const read = file => JSON.parse(fs.readFileSync(path.join(out, file)));
const state = read('comparison.json');
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
const baseline = versions.find(v => v.version === state.baseline && v.status === 'complete');
for (const row of versions.filter(v => v.status === 'complete')) {
  row.deltaPercent = Object.fromEntries(['peakRss', 'steadyRss', 'peakHeap', 'steadyHeap'].map(metric => [metric,
    delta(row.aggregates.combined[metric].median, baseline?.aggregates.combined[metric].median)]));
}
const warnings = [];
for (const row of versions.filter(v => v.status === 'complete')) {
  for (const target of ['server', 'client']) {
    const shapes = row.runs.map(r => JSON.stringify(r[target].shape));
    if (new Set(shapes).size > 1) warnings.push(`${row.version} ${target} 的构建规模在轮次之间发生变化，请查看 JSON 中每轮的 shape。`);
    if (baseline) {
      const current = row.runs[0][target].shape;
      const previous = baseline.runs[0][target].shape;
      const labels = { modules: '模块数', chunks: 'chunk 数', jsBytes: 'JS 字节数', assetFiles: 'asset 数' };
      const changes = Object.keys(labels).filter(key => current[key] !== previous[key])
        .map(key => `${labels[key]} ${previous[key].toLocaleString('en')} → ${current[key].toLocaleString('en')}`);
      if (changes.length) warnings.push(`${row.version} ${target} 相对 ${state.baseline}：${changes.join('；')}（第一轮）。`);
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
const environmentText = report.environment ? `${report.environment.node} · ${report.environment.platform}/${report.environment.arch} · Rayon ${report.environment.rayon} / Tokio ${report.environment.tokio}` : '无有效测量';
const colors = ['#2563eb', '#0f766e', '#e67e22', '#9333ea', '#dc2626', '#475569'];
const methods = [
  `使用每个版本自己的 npm release core 和 binding，不加载诊断 binding，也不采集 heap snapshot。各版本固定运行 ${state.options.runs} 轮，所有版本、轮次及 server/client 进程串行执行；轮次之间轮换版本顺序，依赖安装在测量前完成。`,
  '各版本共用一次生成的同一份输入、相同配置与插件、Node 和 worker 数。记录生成清单、输入脚本 SHA-256、实际 core/binding 版本，以及各版本的独立依赖锁文件；不会修改仓库原来的依赖。构建规模表中的 JS 字节数在插件追加注释前统计。',
  '每轮先把 server/client 的发布构建 RSS 曲线按各自开始时刻对齐叠加，再取叠加峰值；较短构建结束后保持最后稳态读数。它包含两份进程运行时，是合计估算，不是原双 compiler 并行构建的实测峰值，也不是两个独立峰值的直接相加。',
  '表格使用各轮指标的中位数，并列出最小值至最大值。稳态是 compiler close 前、空闲和四次显式 GC 后五次读数的中位数。RSS 每 20 ms 进程外采样，V8 每 50 ms 及 hook 边界采样，JS 同步阻塞会留下采样空隙。',
  '曲线展示合计 RSS 峰值最接近中位数的一轮实测数据，并非逐时刻拼接的中位数曲线。V8 指标是 heapUsed；RSS 减去 V8 不能解释成 Rust 存活数据。数据结构和分配位置仍需单版本深度诊断报告。',
  `Δ 相对于请求列表中的第一个版本 ${state.baseline}。失败或未跑满指定轮数的版本不参与排名，也不填零；请结合波动范围和输出规模判断变化，单轮结果仅用于快速检查。`,
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1180 368" role="img" aria-label="${esc(name)}"><style>text{font:12px system-ui;fill:#475569}</style><rect width="1180" height="368" fill="white"/><text x="12" y="25">GiB</text>${grid}${lines}<text x="590" y="360" text-anchor="middle">构建开始后的秒数</text></svg>`;
}
function table(target) {
  return `<div class="scroll"><table><thead><tr><th>版本</th><th>RSS 峰值 GiB</th><th>RSS 稳态 GiB</th><th>V8 稳态 GiB</th><th>RSS 峰值 Δ</th><th>RSS 稳态 Δ</th></tr></thead><tbody>${versions.map(row => {
    if (row.status !== 'complete') return `<tr><td>${esc(row.version)}</td><td colspan="5" class="failed">未完成：${esc(row.error)}</td></tr>`;
    const data = row.aggregates[target];
    const cell = metric => `<td><b>${gib(data[metric].median)}</b><small>${gib(data[metric].min)} – ${gib(data[metric].max)}</small></td>`;
    return `<tr><td>${esc(row.version)}</td>${cell('peakRss')}${cell('steadyRss')}${cell('steadyHeap')}<td>${percent(delta(data.peakRss.median, baseline?.aggregates[target].peakRss.median))}</td><td>${percent(delta(data.steadyRss.median, baseline?.aggregates[target].steadyRss.median))}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
const legends = complete.map((v,i) => `<span style="color:${colors[i%colors.length]}">● ${esc(v.version)} · 第 ${v.aggregates.representativeRound} 轮</span>`).join(' ');
const shapes = complete.flatMap(v => ['server','client'].map(t => ({ version:v.version, target:t, ...v.representative[t].shape, hwm: v.representative[t].kernelHighWater })));
const shapeTable = `<div class="scroll"><table><thead><tr><th>版本</th><th>目标</th><th>模块数</th><th>chunk 数</th><th>JS MiB</th><th>asset 数</th><th>代表轮 VmHWM GiB</th></tr></thead><tbody>${shapes.map(r => `<tr><td>${esc(r.version)}</td><td>${r.target}</td><td>${r.modules}</td><td>${r.chunks}</td><td>${(r.jsBytes/2**20).toFixed(1)}</td><td>${r.assetFiles}</td><td>${gib(r.hwm)}</td></tr>`).join('')}</tbody></table></div>`;
const rssSvg = chart('combined','rss','各版本合计 RSS 曲线');
fs.writeFileSync(path.join(out,'timeline.svg'),rssSvg || '<svg xmlns="http://www.w3.org/2000/svg"/>');
let html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rspack 版本内存对比</title><style>body{font:15px/1.65 system-ui,sans-serif;background:#f3f6fa;color:#172b45;margin:0}main{max-width:1280px;padding:30px;margin:auto}h1{font-size:32px;margin-bottom:8px}h2{margin-top:30px}article,details{background:white;border:1px solid #dae2ec;border-radius:10px;padding:20px;margin:18px 0}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:12px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}small{display:block;color:#64748b;font-size:12px}.failed{color:#b91c1c;white-space:normal;text-align:left}.legend span{margin-right:20px}svg{width:100%;height:auto}summary{cursor:pointer;font-weight:600}li{margin:8px 0}a{color:#2563eb}select{font:inherit;padding:7px 12px}section[hidden]{display:none}</style><main><h1>Rspack 版本内存对比</h1><p>${esc(state.options.preset)} · ${state.manifest.modules.toLocaleString('en')} 个生成模块 · 每版本 ${state.options.runs} 轮 · 基准 ${esc(state.baseline)}</p><small>${esc(environmentText)} · ${esc(state.createdAt)}</small><p>每个单元格为中位数，下方为本次各轮最小值至最大值。正 Δ 表示内存增加，负 Δ 表示减少。</p><label>查看：<select id="target"><option value="combined">两端叠加（估算）</option><option value="server">server</option><option value="client">client</option></select></label>`;
for (const target of ['combined','server','client']) html += `<section data-target="${target}" ${target==='combined'?'':'hidden'}><h2>${target==='combined'?'两端叠加':target}</h2><article>${table(target)}</article><article><h3>RSS 曲线</h3><div class="legend">${legends}</div>${chart(target,'rss',`${target} RSS`)}</article><details><summary>V8 heapUsed 曲线</summary>${chart(target,'v8',`${target} V8`)}</details></section>`;
html += `${warnings.length?`<article><h2>输出变化</h2><ul>${warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></article>`:''}<details><summary>构建规模与内核高水位</summary>${shapeTable}</details><details><summary>测量口径与复现数据</summary><ol>${methods.map(m=>`<li>${esc(m)}</li>`).join('')}</ol><p><a href="comparison.json">采集计划与输入摘要</a> · <a href="report.json">完整结果</a> · <a href="report.csv">CSV</a> · <a href="report.md">Markdown</a></p></details></main><script>document.querySelector('#target').addEventListener('change',e=>document.querySelectorAll('[data-target]').forEach(s=>s.hidden=s.dataset.target!==e.target.value));</script></html>`;
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
let md=`# Rspack 版本内存对比\n\n${state.options.preset}，每版本 ${state.options.runs} 轮，基准 ${state.baseline}。以下为中位数，范围为各轮最小值–最大值。\n\n${environmentText} · ${state.manifest.modules} 个生成模块 · ${state.createdAt}。\n\n![对比曲线](timeline.svg)\n`;
for (const target of ['combined','server','client']) {
  md+=`\n## ${target}\n\n| 版本 | RSS 峰值 GiB（范围） | RSS 稳态 GiB | V8 稳态 GiB | 峰值 Δ | 稳态 Δ |\n| --- | ---: | ---: | ---: | ---: | ---: |\n`;
  for (const row of versions) {
    if(row.status!=='complete'){md+=`| ${row.version} | 未完成 | — | — | — | — |\n`;continue;}
    const d=row.aggregates[target];
    md+=`| ${row.version} | ${gib(d.peakRss.median)} (${gib(d.peakRss.min)}–${gib(d.peakRss.max)}) | ${gib(d.steadyRss.median)} | ${gib(d.steadyHeap.median)} | ${percent(delta(d.peakRss.median,baseline?.aggregates[target].peakRss.median))} | ${percent(delta(d.steadyRss.median,baseline?.aggregates[target].steadyRss.median))} |\n`;
  }
}
md+=`\n## 测量口径\n\n${methods.map(m=>'- '+m).join('\n')}\n`;
if(warnings.length)md+=`\n## 输出变化\n\n${warnings.map(w=>'- '+w).join('\n')}\n`;
fs.writeFileSync(path.join(out,'report.md'),md);
console.log(`Wrote ${out}/report.html`);
