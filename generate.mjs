// All identifiers, edges, statements and data below are synthesized from integers.
import fs from 'node:fs';
import path from 'node:path';

const preset = process.argv[2] ?? 'full';
if (!['smoke', 'full'].includes(preset))
  throw Error('usage: npm run generate -- [full|smoke]');
const small = preset === 'smoke';
const routes = small ? 24 : 1408;
const libraries = small ? 12 : 384;
const destination = path.resolve('generated-' + preset);
if (
  fs.existsSync(destination) &&
  !fs.existsSync(path.join(destination, '.synthetic-fixture'))
) {
  throw Error('Refusing to replace an unmarked directory: ' + destination);
}
const root = fs.mkdtempSync(destination + '-');
fs.writeFileSync(path.join(root, '.synthetic-fixture'), '1\n');
const totals = { modules: 0, imports: 0, dynamicImports: 0, sourceBytes: 0 };
function write(name, source) {
  fs.writeFileSync(path.join(root, name), source);
  totals.modules++;
  totals.sourceBytes += Buffer.byteLength(source);
}
let state = 0x93ab72;
const rand = () =>
  (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const range = (n) => Array.from({ length: n }, (_, i) => i);
const layer = 'distribution/compiled/units/standard/implementation';
const member = (i) =>
  './' +
  layer +
  '/segment-' +
  Math.floor(i / 8) +
  '/component-' +
  i +
  (i % 4 === 1 ? '.cjs' : '.js');
const features = 'workspaces/application/packages/features/src/async';
const family = (lib, g) =>
  lib
    ? 'node_modules/.store/unit-' +
      g +
      '@1.0.0_peer-runtime@1.0.0_peer-platform@1.0.0/node_modules/unit-' +
      g
    : features + '/area-' + g;
function makeFamily(lib, g) {
  const dir = family(lib, g);
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  if (lib && !fs.existsSync(path.join(root, 'node_modules/unit-' + g))) {
    fs.symlinkSync(
      path.relative('node_modules', dir),
      path.join(root, 'node_modules/unit-' + g),
      'dir',
    );
  }
  if (lib)
    fs.writeFileSync(
      path.join(root, dir, 'package.json'),
      JSON.stringify({
        name: 'unit-' + g,
        main: './root.js',
        sideEffects: false,
      }),
    );
  const n = lib ? 24 : 3 + Math.floor(63 * rand() ** 2.7);
  const roots = [];
  for (let i = 0; i < n; i++) {
    // A branching tree ensures reachability. Additional forward edges create
    // diamonds and popular lower layers without putting the whole app in one chunk.
    const deps = new Set([2 * i + 1, 2 * i + 2].filter((j) => j < n));
    for (let k = 0; k < 13 && i + 1 < n; k++)
      deps.add(i + 1 + Math.floor(rand() ** 1.4 * (n - i - 1)));
    const ids = [...deps];
    const size = 1 + Math.floor(145 * rand() ** 3);
    const file = member(i);
    const cjs = i % 4 === 1;
    const imports = ids.map((j) => {
      const specifier =
        './' + path.posix.relative(path.posix.dirname(file), member(j));
      return cjs
        ? `const { evaluate:d${j} } = require('${specifier}');`
        : `import { evaluate as d${j} } from '${specifier}';`;
    });
    const rows = range(size).map(
      (j) =>
        `  [${j}, "${((rand() * 2 ** 32) >>> 0).toString(16)}_界_${lib ? 'r' : 'reference_record'}_${g}_${i}", ${(rand() * 1e7) | 0}],`,
    );
    const steps = range(Math.ceil(size / 4)).map(
      (j) => `  if ((v & ${j + 1}) === ${j}) v = (v + table[${j}][2]) | 0;`,
    );
    const source = [
      ...imports,
      'const table = [',
      ...rows,
      '];',
      (cjs ? '' : 'export ') + 'function evaluate(v) {',
      ...steps,
      ...ids.map((j, k) => `  if (v === ${-1 - k}) return d${j}(v + 1);`),
      ...ids
        .filter((_, k) => k % 2 === 0)
        .map((j, k) => `  if (v === ${100000 + k}) return d${j}(v >> 1);`),
      '  return table[(v >>> 0) % table.length][1];',
      '}',
      cjs ? 'module.exports = { evaluate };' : '',
      '',
    ].join('\n');
    fs.mkdirSync(path.join(root, dir, path.dirname(file)), { recursive: true });
    write(dir + '/' + file, source);
    totals.imports += ids.length;
    // Add transparent ESM re-export layers; the optimizer can bypass them.
    if (i % 4 === 0) {
      write(dir + '/b' + i + '.js', `export { evaluate } from '${file}';\n`);
      roots.push(`export { evaluate as e${i} } from './b${i}.js';`);
      totals.imports += 2;
    }
  }
  // Close a few small cycles across package boundaries. Imports are only
  // called at runtime, so cyclic evaluation has no initialization hazard.
  if (lib && g % 8 <= 1) {
    const peer = g % 8 === 0 ? g + 1 : g - 1;
    if (peer < libraries) {
      roots.push(`export { e0 as neighbor } from 'unit-${peer}';`);
      totals.imports++;
    }
  }
  // A minority of leaf routes are discovered from a parent route, producing
  // a second asynchronous level in both compilers.
  if (!lib && g % 8 < 2 && g + 2 < routes) {
    roots.push(`export const next = () => import('../area-${g + 2}/root.js');`);
    totals.dynamicImports++;
  }
  if (!lib) {
    // Heavy-tailed sharing: most routes are small; a few see dozens of packages.
    const uses = new Set();
    const fan = Math.min(libraries, Math.floor(55 * rand() ** 9));
    while (uses.size < fan) uses.add(Math.floor(rand() ** 1.25 * libraries));
    roots.push(
      ...[...uses].map((j) => `export * as lib${j} from 'unit-${j}';`),
    );
    totals.imports += uses.size;
    if (g % 6 === 0) {
      const data = Buffer.alloc(64 * 1024);
      for (let i = 0; i < data.length; i++)
        data[i] = ((i * 29) ^ (g * 13) ^ (i >>> 8) ^ (g >>> (i % 8))) & 255;
      fs.writeFileSync(path.join(root, dir, 'shape.bin'), data);
      roots.push("export { default as shape } from './shape.bin';");
      totals.modules++;
      totals.sourceBytes += data.length;
      totals.imports++;
    }
    if (g % 4 === 0) {
      const values = range(1200).map((j) => [j, 'key_' + g + '_' + j, j * 17]);
      write(dir + '/values.json', JSON.stringify(values));
      roots.push("export { default as values } from './values.json';");
      totals.imports++;
    }
    if (g % 5 < 2) {
      const css = range(1000)
        .map(
          (i) =>
            `.s${g}_${i} { padding: ${i}px; color: #${(0xa00000 + g * 31 + i).toString(16)}; }`,
        )
        .join('\n');
      write(dir + '/style.css', css);
      roots.push("import './style.css';");
      totals.imports++;
    }
  }
  write(dir + '/root.js', roots.join('\n') + '\n');
}
for (let i = 0; i < libraries; i++) makeFamily(true, i);
for (let i = 0; i < routes; i++) makeFamily(false, i);
for (const [name, offset, stride] of [
  ['web', 0, 1],
  ['node-a', 0, 2],
  ['node-b', 1, 2],
]) {
  const lines = [];
  for (let i = offset; i < routes; i += stride)
    if (i % 8 !== 2 && i % 8 !== 3)
      lines.push(`  () => import('./${features}/area-${i}/root.js'),`);
  write(
    name + '.js',
    'globalThis.registry = [\n' + lines.join('\n') + '\n];\n',
  );
  totals.dynamicImports += lines.length;
}
const manifest = { preset, routes, libraries, ...totals };
fs.writeFileSync(
  path.join(root, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
);
fs.rmSync(destination, { recursive: true, force: true });
fs.renameSync(root, destination);
console.log(manifest);
