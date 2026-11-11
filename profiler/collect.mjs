import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';

export async function collect({ preset, target, lane, out, checkpoint, binding, coreRoot, expectedVersion }) {
  fs.mkdirSync(out, { recursive: true });
  const log = fs.openSync(path.join(out, 'build.log'), 'w');
  const env = { ...process.env };
  // A caller's override must not silently change the release/JS measurement lanes.
  delete env.NAPI_RS_NATIVE_LIBRARY_PATH;
  delete env.BENCH_CORE_ROOT;
  delete env.BENCH_EXPECTED_VERSION;
  if (coreRoot) {
    if (lane !== 'release') throw Error('Version comparisons require the release lane');
    env.BENCH_CORE_ROOT = coreRoot;
    env.BENCH_EXPECTED_VERSION = expectedVersion;
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
  }
  if (lane === 'native') env.NAPI_RS_NATIVE_LIBRARY_PATH = binding;
  const child = fork(new URL('./worker.mjs', import.meta.url), [preset, target, lane, out, checkpoint ?? 'done#1'], {
    execArgv: ['--expose-gc', '--max-old-space-size=16384'], env,
    stdio: ['ignore', log, log, 'ipc'],
  });
  const rss = [], js = [], smaps = [];
  let origin, timer, slowTimer;
  const ms = () => Number(process.hrtime.bigint() - origin) / 1e6;
  const readStatus = () => {
    try {
      const s = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
      const value = name => Number(s.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024;
      rss.push({ ms: ms(), rss: value('VmRSS'), hwm: value('VmHWM') });
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e; }
  };
  const readSmaps = () => {
    try {
      const s = fs.readFileSync(`/proc/${child.pid}/smaps_rollup`, 'utf8');
      const item = { ms: ms() };
      for (const key of ['Rss', 'Pss', 'Private_Dirty', 'Private_Clean', 'Anonymous', 'Swap'])
        item[key] = Number(s.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024;
      smaps.push(item);
    } catch (e) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(e.code)) throw e; }
  };
  child.on('message', message => {
    if (message.type === 'begin') {
      origin = BigInt(message.origin);
      readStatus(); readSmaps();
      timer = setInterval(readStatus, 20); slowTimer = setInterval(readSmaps, 200);
      child.send('ready');
    } else if (message.type === 'memory') js.push(message.sample);
  });
  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`${target}/${lane}: ${signal ?? code}; see ${out}/build.log`)));
    });
  } finally {
    clearInterval(timer); clearInterval(slowTimer); fs.closeSync(log);
    fs.writeFileSync(path.join(out, 'timeline.json'), JSON.stringify({ rss, js, smaps }));
  }
  if (!rss.length || !js.length) throw Error('Empty timeline');
  const result = JSON.parse(fs.readFileSync(path.join(out, 'worker.json')));
  // Discard the close/destruction tail; steady state is while the compiler is alive.
  const end = result.steady.at(-1).ms;
  const curve = rss.filter(s => s.ms <= end);
  const peak = curve.reduce((a, b) => b.rss > a.rss ? b : a);
  const phases = result.phases.filter(s => !s.phase.startsWith('snapshot:'));
  const nearest = phases.reduce((a, b) => Math.abs(b.ms - peak.ms) < Math.abs(a.ms - peak.ms) ? b : a);
  const summary = { peak, checkpoint: `${nearest.phase}#${nearest.occurrence}`, checkpointMs: nearest.ms,
    checkpointGapMs: nearest.ms - peak.ms, end, kernelHighWater: result.kernelHighWater };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}
