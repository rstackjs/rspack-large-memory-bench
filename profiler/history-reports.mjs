#!/usr/bin/env node
// Export each recorded version from its original measurements, without rebuilding.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { run } from './environment.mjs';
import { stable, updateReadme } from './history-model.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
process.chdir(root);
const read=file=>JSON.parse(fs.readFileSync(file));
const history=read('history/releases.json');
const files=['comparison.json','report.html','report.md','report.csv','report.json','timeline.svg'];
const output=path.resolve('reports/memory');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'memory-reports-'));
let index='# Historical release memory reports\n\nEach directory contains a standalone HTML report, a GitHub-readable Markdown report, CSV, JSON and an SVG curve. Download and open `report.html` for the server/client selector. These reports use three full release builds per version, with server and client measured serially. They show RSS and V8 counters, not Rust allocation snapshots or JS object-size tables. No builds are run when exporting.\n\n';
index+='The JSON retains every round, input hashes and binding versions. Independent environments have separate directories. The original raw collection is not required to open the exported reports.\n\n';
try {
  for(const series of history.series) {
    if(!/^[a-z0-9][a-z0-9-]*$/.test(series.id))throw Error('Invalid history series');
    index+=`## ${series.id}\n\n| Version | Read on GitHub | Open locally | Data |\n| --- | --- | --- | --- |\n`;
    for(const row of series.releases) {
      if(!stable(row.version) || path.basename(row.source.runId)!==row.source.runId)throw Error('Invalid history source');
      const relative=`${series.id}/${row.version}`;
      const target=path.join(output,relative);
      const source=path.resolve('results/compare-full',row.source.runId);
      if(fs.existsSync(path.join(source,'comparison.json'))) {
        const state=read(path.join(source,'comparison.json'));
        const one=path.join(scratch,relative);fs.mkdirSync(one,{recursive:true});
        state.options.versions=[row.version];state.baseline=row.version;
        state.versions={[row.version]:state.versions[row.version]};
        state.order=state.order.filter(r=>r.version===row.version);
        if(state.versions[row.version]?.status!=='complete')throw Error('Incomplete source report');
        fs.writeFileSync(path.join(one,'comparison.json'),JSON.stringify(state,null,2));
        for(const {round} of state.versions[row.version].rounds) for(const lane of ['server','client']) {
          const prefix=`${row.version}/run-${round}/${lane}`;
          fs.mkdirSync(path.join(one,prefix),{recursive:true});
          for(const name of ['worker.json','timeline.json']) fs.copyFileSync(path.join(source,prefix,name),path.join(one,prefix,name));
        }
        await run(process.execPath,['profiler/versions-report.mjs',one]);
        const report=read(path.join(one,'report.json'));
        for(const lane of ['combined','server','client']) assert.deepEqual(report.versions[0].aggregates[lane],row.metrics[lane]);
        assert.deepEqual(report.inputs,series.protocol.inputs);
        assert.deepEqual(report.environment,series.protocol.environment);
        fs.mkdirSync(target,{recursive:true});
        for(const name of files) {
          if(name==='report.json') fs.writeFileSync(path.join(target,name),JSON.stringify(read(path.join(one,name)))+'\n');
          else fs.copyFileSync(path.join(one,name),path.join(target,name));
        }
      } else {
        // A clone already contains the published reports; do not discard them.
        for(const name of files) if(!fs.existsSync(path.join(target,name)))throw Error(`Missing source measurements and exported ${relative}/${name}`);
        const report=read(path.join(target,'report.json'));
        for(const lane of ['combined','server','client']) assert.deepEqual(report.versions[0].aggregates[lane],row.metrics[lane]);
      }
      index+=`| ${row.version} | [Markdown](${relative}/report.md) | [HTML](${relative}/report.html) | [JSON](${relative}/report.json) · [CSV](${relative}/report.csv) |\n`;
    }
    index+='\n';
  }
  fs.writeFileSync(path.join(output,'README.md'),index.trimEnd()+'\n');
  fs.writeFileSync('README.md',updateReadme(fs.readFileSync('README.md','utf8'),history));
} finally {fs.rmSync(scratch,{recursive:true,force:true});}
console.log(`Exported reports to ${output}`);
