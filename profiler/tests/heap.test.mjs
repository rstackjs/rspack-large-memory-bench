import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('heap parser handles reordered fields, escaped names, and counts first objects once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-parser-'));
  try {
    const fixture = {
      snapshot: { meta: { node_fields: ['name', 'self_size', 'type', 'id'],
        node_types: ['string', 'number', ['object', 'string', 'array'], 'number'] }, node_count: 4 },
      nodes: [0, 10, 0, 1, 0, 30, 0, 2, 1, 5, 1, 3, 2, 7, 2, 4],
      edges: [1, 2, 3], strings: ['Map"\\\n类', 'payload should not be a group name', '(elements)'],
    };
    fs.writeFileSync(path.join(dir, 'input'), JSON.stringify(fixture, null, 1));
    const result = spawnSync('python3', ['profiler/heap.py', path.join(dir, 'input'), path.join(dir, 'result')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'result')));
    assert.equal(data.totalSelfBytes, 52);
    assert.equal(data.nodeCount, 4);
    assert.equal(data.groups[0].name, fixture.strings[0]);
    assert.equal(data.groups[0].bytes, 40);
    assert.equal(data.groups[0].count, 2);
    assert.ok(!JSON.stringify(data).includes('payload should'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
