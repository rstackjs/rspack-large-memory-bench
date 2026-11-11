import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export async function run(command, argv, options = {}) {
  const p = spawn(command, argv, { stdio: 'inherit', ...options });
  await new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`${command} failed (${signal ?? code})`)));
  });
}
export async function launchDocker(root, arguments_) {
  const cache = path.join(root, '.profile-cache');
  fs.mkdirSync(cache, { recursive: true });
  const info = spawnSync('docker', ['info', '--format', '{{.Architecture}}'], { encoding: 'utf8' });
  if (info.status !== 0) throw Error('Start Docker first (or select an engine with DOCKER_CONTEXT).');
  const arch = { aarch64: 'arm64', x86_64: 'amd64', arm64: 'arm64', amd64: 'amd64' }[info.stdout.trim()];
  if (!arch) throw Error('The profiler supports native Linux arm64 and amd64 Docker engines.');
  const platform = `linux/${arch}`;
  const releaseOnly = arguments_[0] === 'compare';
  const image = releaseOnly ? 'rspack-large-memory-releases' : 'rspack-large-memory-profiler';
  const dockerfile = releaseOnly ? 'profiler/releases.Dockerfile' : 'profiler/Dockerfile';
  const imageKey = `${arch}:${digest(dockerfile)}`;
  const inspected = spawnSync('docker', ['image', 'inspect', '--format', '{{ index .Config.Labels "bench.profiler.input" }}', image], { encoding: 'utf8' });
  if (inspected.status !== 0 || inspected.stdout.trim() !== imageKey)
    await run('docker', ['build', '--platform', platform, '--label', `bench.profiler.input=${imageKey}`, '-t', image, '-f', dockerfile, 'profiler']);
  const modules = path.join(cache, 'linux-node_modules');
  fs.mkdirSync(modules, { recursive: true });
  fs.mkdirSync(path.join(root, 'results'), { recursive: true });
  await run('docker', ['run', '--rm', '--init', '--platform', platform,
    ...(process.env.DOCKER_DNS ? ['--dns', process.env.DOCKER_DNS] : []),
    '-v', `${root}:/input:ro`, '-v', `${modules}:/case/node_modules`,
    '-v', `${cache}:/case/.profile-cache`, '-v', `${path.join(root, 'results')}:/case/results`,
    '-v', `${path.join(cache, 'cargo')}:/usr/local/cargo/registry`,
    '-e', `RAYON_NUM_THREADS=${process.env.RAYON_NUM_THREADS ?? 6}`,
    '-e', `TOKIO_WORKER_THREADS=${process.env.TOKIO_WORKER_THREADS ?? 6}`,
    '-e', `CARGO_BUILD_JOBS=${process.env.CARGO_BUILD_JOBS ?? 4}`,
    '-e', `PROFILE_UID=${process.platform === 'linux' ? process.getuid() : ''}`,
    '-e', `PROFILE_GID=${process.platform === 'linux' ? process.getgid() : ''}`,
    image, 'python3', '/input/profiler/bootstrap.py', ...arguments_]);
}
