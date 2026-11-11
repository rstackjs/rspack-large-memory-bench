"""Symbolize sampled Rust allocations. Buckets describe allocation provenance, not ownership."""
import json
from pathlib import Path
import subprocess
import sys
from collections import defaultdict


def analyze(file, binary):
    raw = json.loads(Path(file).read_text())
    addresses = sorted({p for site in raw['sites'] for p in site['frames']})
    result = subprocess.run(['addr2line', '-f', '-C', '-e', binary], input='\n'.join(addresses) + '\n',
                            text=True, capture_output=True, check=True)
    lines = result.stdout.splitlines()
    if len(lines) != len(addresses) * 2:
        raise ValueError('Unexpected addr2line output')
    symbols = {pc: {'function': lines[i * 2], 'location': lines[i * 2 + 1]}
               for i, pc in enumerate(addresses)}
    categories = [
        ('JsSourceFromJs', 'JS-provided source buffers'),
        ('ustr_fxhash', 'Interned strings / string table'),
        ('hstr::', 'Interned strings / atoms'),
        ('swc_atoms', 'Interned strings / atoms'),
        ('SourceMapSource', 'SourceMapSource / source text and mappings'),
        ('RspackSourceMapBuilder', 'SourceMap / mappings'),
        ('RawStringSource', 'RawStringSource / string payload'),
        ('RawBufferSource', 'RawBufferSource / byte payload'),
        ('OriginalSource', 'OriginalSource'),
        ('ReplaceSource', 'ReplaceSource'),
        ('ConcatSource', 'ConcatSource'),
        ('CachedSource', 'CachedSource'),
        ('SourceMap', 'SourceMap / mappings'),
        ('source_map', 'SourceMap / mappings'),
        ('JavaScriptCompiler', 'Transformed JavaScript / compiler buffers'),
        ('swc_next_ecma_ast', 'SWC AST / node tables'),
        ('swc_next_ecma_parser', 'SWC parser / tokens'),
        ('ModuleGraph', 'ModuleGraph'),
        ('module_graph', 'ModuleGraph'),
        ('ExportsInfo', 'ExportsInfo'),
        ('exports_info', 'ExportsInfo'),
        ('ChunkGraph', 'ChunkGraph'),
        ('chunk_graph', 'ChunkGraph'),
        ('NormalModule', 'NormalModule'),
        ('normal_module', 'NormalModule'),
        ('CodeGeneration', 'Code generation results'),
        ('code_generation', 'Code generation results'),
        ('swc_ecma_ast', 'SWC AST'),
        ('swc_ecma_parser', 'SWC parser / AST'),
        ('swc_css', 'SWC CSS'),
        ('rspack_resolver', 'Resolver'),
        ('oxc_resolver', 'Resolver'),
        ('rspack_sources', 'Other source buffers'),
        ('rspack_plugin_devtool', 'Source maps / devtool'),
        ('rspack_plugin_javascript', 'JavaScript plugin'),
        ('rspack_plugin_split_chunks', 'Split chunks'),
        ('rspack_core', 'Other compilation data'),
        ('rspack_binding', 'Rust ↔ JS binding'),
        ('napi', 'N-API data'),
        ('swc_', 'Other SWC data'),
    ]
    groups = defaultdict(lambda: dict(bytes=0, count=0, samples=0))
    locations = defaultdict(lambda: dict(bytes=0, count=0, samples=0))
    detailed = []
    for site in raw['sites']:
        frames = [symbols[p] for p in site['frames']]
        useful = [f for f in frames if not any(x in f['function'] for x in
                   ['rspack_allocator', 'mimalloc', '__rust', 'alloc::alloc::', 'alloc::raw_vec::'])]
        # Walk from the allocation outwards. An async graph-builder frame at the
        # bottom must not turn every parser/source buffer into 'ModuleGraph'.
        category = 'Other / unresolved Rust allocations'
        for frame in useful:
            function = frame['function']
            if function.startswith(('<core::', 'core::', '<std::', 'std::', '<tokio::', 'tokio::', '<rayon::', 'rayon::')):
                continue
            match = next((name for token, name in categories if token in function), None)
            if match:
                category = match
                break
        owner = next((f for f in useful if f['location'].startswith('/rspack/') or
                      f['function'].lstrip('<').startswith(('swc_', 'oxc_', 'rspack_', 'napi::'))),
                     useful[0] if useful else {'function': '(unresolved)', 'location': '??:0'})
        key = owner['function'], owner['location']
        group = groups[category]
        group['bytes'] += site['liveBytes']
        group['count'] += site['liveCount']
        group['samples'] += site['liveSamples']
        location = locations[key]
        location['bytes'] += site['allocatedBytes']
        location['count'] += site['allocationCount']
        location['samples'] += site['allocationSamples']
        detailed.append({**site, 'category': category, 'owner': owner, 'stack': frames})
    return {k: v for k, v in raw.items() if k != 'sites'} | {
        'totalLiveBytes': sum(s['liveBytes'] for s in raw['sites']),
        'totalAllocatedBytes': sum(s['allocatedBytes'] for s in raw['sites']),
        'groups': sorted([{'name': k, **v} for k, v in groups.items()], key=lambda r: -r['bytes']),
        'locations': sorted([{'name': k[0], 'location': k[1], **v} for k, v in locations.items()], key=lambda r: -r['bytes']),
        'symbolCoverage': sum(s['liveBytes'] for s in detailed if s['owner']['function'] != '(unresolved)') / max(1, sum(s['liveBytes'] for s in detailed)),
        'sites': detailed,
    }


if __name__ == '__main__':
    Path(sys.argv[3]).write_text(json.dumps(analyze(sys.argv[1], sys.argv[2])) + '\n')
