// Functions shared by the report and regression tests. All byte sums are exclusive.
export const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) throw Error('Cannot take median of empty samples');
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
export function valueAt(curve, ms, key) {
  if (!curve.length) throw Error('Missing curve');
  let low = 0, high = curve.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (curve[mid].ms <= ms) low = mid + 1; else high = mid;
  }
  return curve[Math.max(0, low - 1)][key];
}
export function sumCurves(a, b, key = 'rss') {
  const times = [...new Set([0, ...a.map(s => s.ms), ...b.map(s => s.ms)])].sort((a, b) => a - b);
  return times.map(ms => ({ ms, [key]: valueAt(a, ms, key) + valueAt(b, ms, key) }));
}
export function mergeGroups(a, b) {
  const map = new Map();
  for (const row of [...a, ...b]) {
    const key = `${row.type ?? ''}\0${row.name}\0${row.location ?? ''}`;
    let merged = map.get(key);
    if (!merged) { merged = { ...row, bytes: 0, count: 0, samples: 0 }; map.set(key, merged); }
    merged.bytes += row.bytes;
    merged.count += row.count ?? 0;
    merged.samples += row.samples ?? 0;
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes);
}
export function jsAllocations(profile) {
  const rows = [];
  function visit(node, caller) {
    const f = node.callFrame;
    const source = f.url ? f : caller;
    if (node.selfSize > 0) rows.push({
      name: (f.functionName || '(anonymous)') + (source && source !== f ? ` ← ${source.functionName || '(anonymous)'}` : ''),
      location: source ? `${source.url}:${source.lineNumber + 1}:${source.columnNumber + 1}` : '(V8 / native)',
      bytes: node.selfSize,
    });
    for (const child of node.children ?? []) visit(child, source);
  }
  visit(profile.head);
  // selfSize already contains V8's sampling estimate. Do not add children or
  // samples again; doing either would double-count inclusive stack sizes.
  return mergeGroups(rows, []);
}
