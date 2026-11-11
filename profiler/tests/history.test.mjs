import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { mergeReport, updateReadme } from '../history-model.mjs';

const existing=JSON.parse(fs.readFileSync('history/releases.json'));
const original=existing.series.find(s=>s.id==='local-linux-arm64');
function fixture() {
  const row=structuredClone(original.releases[0]);
  const report={schemaVersion:1,status:'complete',createdAt:row.measuredAt,...structuredClone(original.protocol),versions:[{
    version:row.version,status:'complete',lockSha256:row.lockSha256,aggregates:row.metrics,
    runs:row.shapes.map(s=>({round:s.round,server:{shape:s.server},client:{shape:s.client}})),
  }]};
  const metadata={versions:[row.version],time:{[row.version]:row.publishedAt}};
  return {report,metadata,empty:{schemaVersion:1,minimumVersion:'2.2.6',series:[]}};
}
test('imports preserve previous measurements and reject incomplete rounds',()=>{
  const {report,metadata,empty}=fixture();
  const once=mergeReport(empty,report,metadata,'test',{runId:'initial'});
  const changed=structuredClone(report); changed.versions[0].aggregates.combined.peakRss.values=[1,2,3];
  assert.deepEqual(mergeReport(once,changed,metadata,'test',{runId:'later'}),once);
  report.versions[0].aggregates.combined.peakRss.values.pop();
  assert.throws(()=>mergeReport(empty,report,metadata,'test',{}),/Incomplete/);
});
test('different architectures and workload revisions require separate history series',()=>{
  const {report,metadata,empty}=fixture();
  const once=mergeReport(empty,report,metadata,'test',{});
  report.environment.arch='x64';
  assert.throws(()=>mergeReport(once,report,metadata,'test',{}),/protocol changed/);
  assert.equal(mergeReport(once,report,metadata,'other',{}).series.length,2);
  report.environment.arch='arm64';report.inputs['generate.mjs']='changed';
  assert.throws(()=>mergeReport(once,report,metadata,'test',{}),/protocol changed/);
});
test('smoke results, prereleases and failed builds never become history rows',()=>{
  const {report,metadata,empty}=fixture();
  report.preset='smoke';assert.throws(()=>mergeReport(empty,report,metadata,'test',{}));
  report.preset='full';report.versions[0].version='2.3.2-rc.1';
  assert.throws(()=>mergeReport(empty,report,metadata,'test',{}),/stable/);
  report.versions[0].status='failed';
  assert.deepEqual(mergeReport(empty,report,metadata,'test',{}),empty);
});
test('README updates only the marked history block and is repeatable',()=>{
  const readme='Before\n<!-- release-memory-history:start -->\nold\n<!-- release-memory-history:end -->\nAfter';
  const updated=updateReadme(readme,existing);
  assert.ok(updated.startsWith('Before\n'));assert.ok(updated.endsWith('\nAfter'));
  assert.ok(updated.includes('20.313'));assert.equal(updateReadme(updated,existing),updated);
  assert.throws(()=>updateReadme('No markers',existing));
});
