# Large dual-compiler memory benchmark

A deterministic synthetic workload for measuring Rspack peak RSS and retained memory. It needs only Node, npm, and a filesystem with symlink support. After installing the pinned public toolchain it runs offline.

```sh
npm ci
npm run generate
npm run bench
npm run check
```

Allow about 32 GiB of RAM and 10 GiB of free space for a full run. For an installation check, use `npm run generate -- smoke` and `npm run bench -- smoke`.

The generator creates asynchronous route trees, shared packages, ESM and CommonJS, styles, JSON and binary resources. A pair of compilers build the generated files with caching and minification disabled. Hooks control when their work overlaps. The asset plugin enumerates filenames, reads sizes one asset at a time, and edits a fraction of the emitted scripts and maps. Its emit hook counts filenames without reading their sources. Other plugins read module sources and export chunk statistics. They do not execute bundles or contact services.

`results/full.json` records peak RSS, memory at hook boundaries and five samples after four explicit GCs before the compilers close. `node inspect.mjs` summarizes output files and mapped source counts after the measured process exits. To compare medians, run the build in fresh processes:

```sh
for n in 1 2 3; do
  npm run bench && cp results/full.json "results/run-$n.json" || exit 1
done
node inspect.mjs > results/shape.json
npm run check -- results/run-1.json results/run-2.json results/run-3.json --shape results/shape.json
```

The rounded values in `baseline.json` are from this generator's full-size Linux arm64 run with Node 24.20.0 and six workers per pool. Checks on other platforms may give different results. Peak RSS and V8 heap usage measure different things; their difference is not a measurement of Rust live allocations.

To share the runnable fixture, use `python3 pack.py large-memory.tar.gz`. It includes only the listed input files and the synthetic baseline; it leaves out installed dependencies, generated sources, outputs, and local measurements.
