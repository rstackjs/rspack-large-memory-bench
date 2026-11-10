// Exercise the binding with synthetic assets. No external services or business rules.
export class Assets {
  apply(compiler) {
    const { RawSource } = compiler.webpack.sources;
    compiler.hooks.thisCompilation.tap('Assets', (compilation) => {
      compilation.hooks.afterProcessAssets.tap('Assets', (assets) => {
        const names = Object.keys(assets);
        const scripts = [];
        const sizes = { js: 0, map: 0, css: 0 };
        for (const name of names) {
          const ext = name.split('.').pop();
          if (!Object.hasOwn(sizes, ext)) continue;
          const size = assets[name].size();
          sizes[ext] += size;
          if (compiler.name === 'server' && ext === 'js') {
            scripts.push({ name, size });
          }
        }
        // Materialize a bounded subset of large emitted sources through the
        // public API. Map whitespace and a trailing JS comment preserve semantics.
        if (compiler.name === 'server') {
          scripts.sort((a, b) => b.size - a.size);
          const selected = scripts.slice(0, Math.ceil(scripts.length / 16));
          for (const { name } of selected) {
            compilation.updateAsset(
              name,
              new RawSource(assets[name].source() + '\n/*1*/'),
            );
            const map = compilation.getAsset(name + '.map');
            if (map)
              compilation.updateAsset(
                map.name,
                new RawSource(
                  JSON.stringify(JSON.parse(map.source.source())) + ' ',
                ),
              );
          }
        }
        this.record(compiler.name, 'asset-read', {
          files: names.length,
          sizes,
        });
      });
    });
    compiler.hooks.emit.tap('Readback', (compilation) => {
      this.record(compiler.name, 'emit-read', {
        files: Object.keys(compilation.assets).length,
      });
    });
  }
  constructor(record) {
    this.record = record;
  }
}

export class StatsExport {
  apply(compiler) {
    compiler.hooks.emit.tap('StatsExport', (compilation) => {
      this.stats = compilation.getStats().toJson({
        assets: true,
        chunks: true,
        entrypoints: true,
        chunkModules: true,
        modules: false,
        chunkGroups: false,
        chunkOrigins: false,
        depth: false,
        source: false,
        timings: false,
        warnings: false,
        errors: false,
        performance: false,
      });
      this.record(compiler.name, 'stats', { rows: this.stats.chunks.length });
    });
  }
  constructor(record) {
    this.record = record;
  }
}

export class ModuleInputs {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('ModuleInputs', (compilation) => {
      compilation.hooks.finishModules.tap('ModuleInputs', (modules) => {
        // Keep the same kind of JS objects a source-inspecting plugin sees.
        // Each key and value comes from the actual compilation.
        this.inputs = new Map();
        for (const mod of modules) {
          const src = mod.originalSource();
          if (src) this.inputs.set(mod.identifier(), src.source());
        }
      });
    });
  }
}
