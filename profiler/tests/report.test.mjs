import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sumCurves, mergeGroups, jsAllocations, median } from '../model.mjs';

test('overlay sums at aligned times, not independent peaks, and holds the shorter run', () => {
  const a = [{ ms: 0, rss: 10 }, { ms: 10, rss: 100 }, { ms: 20, rss: 20 }];
  const b = [{ ms: 0, rss: 20 }, { ms: 20, rss: 100 }, { ms: 30, rss: 30 }];
  const curve = sumCurves(a, b);
  assert.deepEqual(curve.map(s => s.rss), [30, 120, 120, 50]);
  assert.equal(Math.max(...curve.map(s => s.rss)), 120);
  assert.equal(median([5, 1, 8, 2]), 3.5);
});

test('V8 cumulative allocations count exclusive node sizes once', () => {
  const frame = (name, line = 0) => ({ functionName: name, url: 'file:///case/plugins.mjs', lineNumber: line, columnNumber: 1 });
  const rows = jsAllocations({ head: { callFrame: frame('root'), selfSize: 10, children: [
    { callFrame: frame('child'), selfSize: 20, children: [] },
    { callFrame: frame('child'), selfSize: 30, children: [] },
  ] }, samples: [{ size: 999999 }] });
  assert.deepEqual(rows.map(r => r.bytes), [50, 10]);
  assert.equal(rows[0].location, 'file:///case/plugins.mjs:1:2');
});

test('group merges preserve type and source location boundaries', () => {
  const rows = mergeGroups([{ type: 'object', name: 'Map', bytes: 10, count: 1 }], [
    { type: 'object', name: 'Map', bytes: 20, count: 2 },
    { type: 'array', name: 'Map', bytes: 40, count: 1 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.type === 'object').bytes, 30);
  assert.equal(rows.find(r => r.type === 'object').count, 3);
});

test('native V8 allocation sites keep the nearest JavaScript caller', () => {
  const rows = jsAllocations({ head: {
    callFrame: { functionName: 'Assets', url: 'file:///case/plugins.mjs', lineNumber: 6, columnNumber: 0 },
    selfSize: 0, children: [{
      callFrame: { functionName: 'next', url: '', lineNumber: -1, columnNumber: -1 },
      selfSize: 42, children: [],
    }],
  } });
  assert.equal(rows[0].name, 'next ← Assets');
  assert.equal(rows[0].location, 'file:///case/plugins.mjs:7:1');
  assert.equal(rows[0].bytes, 42);
});
