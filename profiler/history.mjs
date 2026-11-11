#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mergeReport, updateReadme } from './history-model.mjs';

process.chdir(fileURLToPath(new URL('..',import.meta.url)));
const [command,...args]=process.argv.slice(2);
let series, reportDir;
for(let i=0;i<args.length;i++) {
  if(args[i]==='--series') series=args[++i];
  else if(command==='import' && !reportDir && !args[i].startsWith('--')) reportDir=path.resolve(args[i]);
  else throw Error(`Unknown argument: ${args[i]}`);
}
if(!['import','render'].includes(command) || (command==='import' && (!reportDir || !/^[a-z0-9][a-z0-9-]*$/.test(series??''))))
  throw Error('Use history.mjs import RUN_DIRECTORY --series SERIES, or history.mjs render');
const read=file=>JSON.parse(fs.readFileSync(file));
fs.mkdirSync('.profile-cache',{recursive:true});
const lock='.profile-cache/history.lock';
try { fs.writeFileSync(lock,String(process.pid),{flag:'wx'}); }
catch(e) { if(e.code!=='EEXIST')throw e; throw Error('History update already running; check for active jobs before removing a stale history.lock'); }
process.on('exit',()=>fs.rmSync(lock,{force:true}));
const historyFile='history/releases.json';
const history=read(historyFile);
const render=data=>updateReadme(fs.readFileSync('README.md','utf8'),data);
if(command==='render') { fs.writeFileSync('README.md',render(history)); process.exit(0); }
const metadata=JSON.parse(execFileSync('npm',['view','@rspack/core','versions','time','--json','--registry=https://registry.npmjs.org'],
  {encoding:'utf8',maxBuffer:32*1024*1024,timeout:120000}));
const report=read(path.join(reportDir,'report.json'));
if(report.status!=='complete') throw Error('Incomplete comparison; history unchanged');
for(const row of report.versions) {
  for(const r of row.runs) for(const target of ['server','client']) {
    const timeline=read(path.join(reportDir,row.version,`run-${r.round}`,target,'timeline.json'));
    if(!timeline.smaps?.length || timeline.smaps.some(s=>s.Swap>0)) throw Error('Missing swap observations or swapped process; history unchanged');
  }
}
const next=mergeReport(history,report,metadata,series,{runId:path.basename(reportDir)});
const markdown=render(next);
fs.writeFileSync(historyFile,JSON.stringify(next,null,2)+'\n');
fs.writeFileSync('README.md',markdown);
console.log(`Recorded ${next.series.find(s=>s.id===series)?.releases.length??0} releases in ${series}.`);
