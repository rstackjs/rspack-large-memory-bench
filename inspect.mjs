// Deliberately run AFTER the measured process exits. Parsing the maps in the
// compiler process would dominate both the heap and the RSS being measured.
import fs from 'node:fs';
import path from 'node:path';

const result = {};
for (const target of ['client', 'server']) {
  const dir = path.join('dist', target);
  const sizes = {};
  const names = new Set();
  const counts = [];
  for (const file of fs.readdirSync(dir)) {
    const kind = file.endsWith('.js.map') ? 'jsMap' : file.split('.').pop();
    const full = path.join(dir, file);
    const bucket = (sizes[kind] ??= { files: 0, bytes: 0 });
    bucket.files++;
    bucket.bytes += fs.statSync(full).size;
    if (kind !== 'jsMap') continue;
    const { sources } = JSON.parse(fs.readFileSync(full, 'utf8'));
    for (const name of sources) names.add(name);
    counts.push(sources.length);
  }
  counts.sort((a, b) => a - b);
  result[target] = {
    sizes,
    distinctMappedSources: names.size,
    mappedOccurrences: counts.reduce((a, b) => a + b, 0),
    sourcesPerMap: Object.fromEntries(
      [50, 90, 95, 99, 100].map((q) => [
        q,
        counts[
          Math.min(counts.length - 1, Math.floor((q * counts.length) / 100))
        ],
      ]),
    ),
  };
}
console.log(JSON.stringify(result, null, 2));
