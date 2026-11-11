import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOptions, schedule, combineTargets, aggregateRuns, summarizeTarget, delta } from '../versions-model.mjs';

test('version CLI accepts exact versions, rejects ranges, duplicates and invalid repeats', () => {
  assert.deepEqual(parseOptions([]).versions, ['2.2.6','2.3.0','2.3.1','2.3.2']);
  assert.deepEqual(parseOptions(['2.3.0-rc.0','--runs','2','--preset','smoke']).runs, 2);
  for (const args of [['latest'],['^2.3.0'],['2.3.0','2.3.0'],['--runs','0'],['--runs','1.5'],['--runs'],['--preset','tiny']])
    assert.throws(()=>parseOptions(args));
});
test('scheduling rotates version order and pairs both compilers within each round', () => {
  assert.deepEqual(schedule(['a','b'],3),[
    {version:'a',round:1},{version:'b',round:1},
    {version:'b',round:2},{version:'a',round:2},
    {version:'a',round:3},{version:'b',round:3},
  ]);
});
test('combined peak is taken after aligning each pair, and aggregates require all rounds', () => {
  const target=(values)=>({rss:values.map((rss,i)=>({ms:i*10,rss})),v8:values.map((heapUsed,i)=>({ms:i*10,heapUsed})),steadyRss:values.at(-1),steadyHeap:values.at(-1)});
  const combined=combineTargets(target([10,100,20]),target([20,20,100]));
  assert.equal(combined.peakRss,120);
  const runs=[1,2,3].map((round)=>{
    const row={peakRss:round*100,steadyRss:round*90,peakHeap:round*20,steadyHeap:round*10};
    return {round,server:row,client:row,combined:row};
  });
  const a=aggregateRuns(runs,3);
  assert.equal(a.combined.peakRss.median,200);
  assert.equal(a.combined.peakRss.min,100);
  assert.equal(a.combined.peakRss.max,300);
  assert.equal(a.representativeRound,2);
  assert.throws(()=>aggregateRuns(runs.slice(0,2),3));
  assert.equal(delta(80,100),-19.999999999999996);
  assert.equal(delta(80,0),null);
});
test('mismatched or instrumented bindings never enter a comparison', () => {
  assert.throws(()=>summarizeTarget({lane:'native',runtime:{}},{},'2.3.2',{}));
  assert.throws(()=>summarizeTarget({lane:'release',runtime:{rspack:'2.3.2',binding:'2.3.1'}},{},'2.3.2',{}));
});
test('an all-failed run produces an honest report without zero memory values', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'versions-report-'));
  try {
    const state={createdAt:'2026-01-01',status:'partial',baseline:'9.9.9',options:{versions:['9.9.9'],runs:3,preset:'smoke'},
      manifest:{modules:1},inputs:{},order:[],versions:{'9.9.9':{status:'failed',error:'<script>unavailable</script>'}}};
    fs.writeFileSync(path.join(dir,'comparison.json'),JSON.stringify(state));
    const result=spawnSync(process.execPath,['profiler/versions-report.mjs',dir],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(fs.readFileSync(path.join(dir,'report.json')));
    assert.equal(report.versions[0].aggregates,undefined);
    assert.equal(report.environment,null);
    const html=fs.readFileSync(path.join(dir,'report.html'),'utf8');
    assert.ok(html.includes('&lt;script&gt;unavailable&lt;/script&gt;'));
    assert.ok(!html.includes('<script>unavailable'));
    assert.ok(!html.includes('NaN'));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('a failed baseline stays unavailable, and mixed runtime settings are rejected', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'versions-partial-'));
  try {
    const manifest={modules:1};
    const state={createdAt:'2026-01-01',status:'partial',baseline:'9.9.9',options:{versions:['9.9.9','2.3.2'],runs:1,preset:'smoke'},
      manifest,inputs:{},order:[],versions:{'9.9.9':{status:'failed'},'2.3.2':{status:'complete',rounds:[{round:1}]}}};
    fs.writeFileSync(path.join(dir,'comparison.json'),JSON.stringify(state));
    const worker={lane:'release',manifest,runtime:{rspack:'2.3.2',binding:'2.3.2',node:'v24.20.0',platform:'linux',arch:'arm64',rayon:'6',tokio:'6'},
      phases:[{phase:'processAssets',modules:1,chunks:1},{phase:'asset-read',sizes:{js:10},files:1},{phase:'done'}],
      steady:Array.from({length:5},(_,i)=>({ms:2+i,rss:90,heapUsed:40})),kernelHighWater:100};
    for(const target of ['server','client']) {
      const lane=path.join(dir,'2.3.2/run-1',target); fs.mkdirSync(lane,{recursive:true});
      fs.writeFileSync(path.join(lane,'worker.json'),JSON.stringify(worker));
      // The 9999-byte close tail must not inflate the measured peak.
      fs.writeFileSync(path.join(lane,'timeline.json'),JSON.stringify({rss:[{ms:0,rss:100},{ms:6,rss:90},{ms:9,rss:9999}],js:[{ms:0,heapUsed:80},{ms:6,heapUsed:40}]}));
    }
    const cli=()=>spawnSync(process.execPath,['profiler/versions-report.mjs',dir],{encoding:'utf8'});
    const result=cli(); assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(fs.readFileSync(path.join(dir,'report.json')));
    assert.equal(report.baseline,'9.9.9');
    assert.equal(report.versions[1].deltaPercent.peakRss,null);
    assert.equal(report.versions[1].aggregates.combined.peakRss.median,200);
    worker.runtime.rayon='8';
    fs.writeFileSync(path.join(dir,'2.3.2/run-1/client/worker.json'),JSON.stringify(worker));
    const mixed=cli(); assert.notEqual(mixed.status,0);
    assert.match(mixed.stderr,/settings differ/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
