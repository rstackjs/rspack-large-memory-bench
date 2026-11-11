import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const deps = path.resolve('.profile-cache/target/release/deps');
const available = process.platform === 'linux' && fs.existsSync(deps);
test('native allocator keeps realloc/free accounting and cumulative bytes separate', { skip: !available }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-profile-'));
  try {
    const source = `#[path = ${JSON.stringify(path.resolve('profiler/native/allocator.rs'))}] mod allocator;
fn main() {
    allocator::start(${JSON.stringify(dir)}.to_owned());
    let mut bytes: Vec<u8> = Vec::with_capacity(1048576);
    std::hint::black_box(&bytes);
    allocator::dump(${JSON.stringify(path.join(dir, 'one.json'))}).unwrap();
    bytes.reserve_exact(2097152);
    std::hint::black_box(&bytes);
    allocator::dump(${JSON.stringify(path.join(dir, 'two.json'))}).unwrap();
    drop(bytes);
    allocator::dump(${JSON.stringify(path.join(dir, 'free.json'))}).unwrap();
    allocator::stop();
}`;
    fs.writeFileSync(path.join(dir, 'test.rs'), source);
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), `[package]
name = "profiler-allocator-test"
version = "0.0.0"
edition = "2024"
[[bin]]
name = "check"
path = "test.rs"
[dependencies]
mimalloc = { version = "=0.1.48", features = ["v3", "local_dynamic_tls"] }
`);
    const target = path.resolve('.profile-cache/test-target');
    let result = spawnSync('cargo', ['build', '--offline', '--release', '--manifest-path', path.join(dir, 'Cargo.toml')], {
      encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: target }, timeout: 120000,
    });
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync(path.join(target, 'release/check'), [], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const read = file => JSON.parse(fs.readFileSync(path.join(dir, file)));
    const total = (data, key) => data.sites.reduce((s, row) => s + row[key], 0);
    const one = read('one.json'), two = read('two.json'), free = read('free.json');
    assert.equal(total(one, 'liveBytes'), 1048576);
    assert.equal(total(two, 'liveBytes'), 2097152);
    assert.equal(total(free, 'liveBytes'), 0);
    assert.equal(total(free, 'allocatedBytes'), 3145728);
    assert.ok(one.sites.some(s => s.frames.length > 0));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
