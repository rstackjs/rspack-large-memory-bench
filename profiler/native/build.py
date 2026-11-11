#!/usr/bin/env python3
"""Build a matching, symbolized diagnostic binding from pinned public Rspack source."""
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import tempfile
from source import unpack
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / '.profile-cache'
REVISION = '4b080493a6b0212813df55c03ab0b89442b08578'
VERSION = '2.3.0-rc.0'
CACHE.mkdir(exist_ok=True)
source = CACHE / 'rspack'
if not source.exists():
    archive = CACHE / 'source.tar.gz'
    urllib.request.urlretrieve(f'https://codeload.github.com/web-infra-dev/rspack/tar.gz/{REVISION}', archive)
    staging = Path(tempfile.mkdtemp(prefix='source-', dir=CACHE))
    try:
        unpack(archive, staging, f'rspack-{REVISION}')
        (staging / f'rspack-{REVISION}').rename(source)
    finally:
        shutil.rmtree(staging)

allocator = ROOT / 'profiler/native/allocator.rs'
# The isolated checkout is public code, patched only for diagnostic instrumentation.
destination = source / 'crates/rspack_allocator/src/lib.rs'
if destination.read_bytes() != allocator.read_bytes():
    shutil.copyfile(allocator, destination)
api = source / 'crates/rspack_binding_api/src/lib.rs'
original = api.read_text().split('// BENCH_PROFILE_EXPORTS')[0]
patched = original + '''// BENCH_PROFILE_EXPORTS
#[napi]
pub fn bench_profile_start(directory: String) { rspack_allocator::start(directory); }
#[napi]
pub fn bench_profile_dump(path: String) -> napi::Result<()> {
    rspack_allocator::dump(&path).map_err(|e| napi::Error::from_reason(e.to_string()))
}
#[napi]
pub fn bench_profile_stop() { rspack_allocator::stop(); }
'''
if api.read_text() != patched:
    api.write_text(patched)
env = os.environ.copy()
env.update(CARGO_TARGET_DIR=str(CACHE / 'target'), CARGO_INCREMENTAL='0',
           CARGO_BUILD_JOBS=os.environ.get('CARGO_BUILD_JOBS', '4'))
# Line tables + demangled generics give allocation locations without full type DWARF.
flags = ['-Cforce-frame-pointers=yes', '-Cforce-unwind-tables=yes',
         '-Csymbol-mangling-version=v0', '-Zshare-generics=y',
         f'--remap-path-prefix={source}=/rspack',
         f'--remap-path-prefix={os.environ.get("CARGO_HOME", "/usr/local/cargo")}/registry/src=/cargo']
common = ['cargo', 'build', '--locked', '--release', '--no-default-features',
          '--config', 'target."cfg(all())".rustflags=' + json.dumps(flags),
          '--config', 'profile.release.lto=false', '--config', 'profile.release.codegen-units=16',
          '--config', 'profile.release.debug=1', '--config', 'profile.release.strip="none"']
for package, features in [('rspack_binding_api', 'plugin,tracing/release_max_level_info,napi-derive/type-def'),
                          ('rspack_node', 'plugin,info-level')]:
    subprocess.run(common + ['-p', package, '--features', features], cwd=source, env=env, check=True)
binary = CACHE / 'target/release/librspack_node.so'
shutil.copyfile(binary, CACHE / 'rspack-profile.node')
(CACHE / 'native-build.json').write_text(json.dumps({
    'rspack': VERSION, 'revision': REVISION, 'allocator': 'mimalloc + byte sampling',
    'arch': {'aarch64': 'arm64', 'x86_64': 'x64'}.get(platform.machine(), platform.machine()),
    'platform': platform.system().lower(),
    'interval': 65536, 'debug': 1, 'lto': False,
    'sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
    'instrumentationSha256': hashlib.sha256(allocator.read_bytes()).hexdigest(),
    'buildScriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
}, indent=2) + '\n')
