import path from 'node:path';
import { Assets, ModuleInputs, StatsExport } from './plugins.mjs';

export function config(root, record) {
  // Fix the overlap between the two compilers using hooks instead of timers.
  const frontEnd = Promise.withResolvers();
  const serverEmit = Promise.withResolvers();
  const overlap = {
    apply(compiler) {
      if (compiler.options.name === 'client') {
        compiler.hooks.beforeCompile.tapPromise(
          'Overlap',
          () => frontEnd.promise,
        );
        compiler.hooks.finishMake.tapPromise(
          'Overlap',
          () => serverEmit.promise,
        );
      } else {
        compiler.hooks.thisCompilation.tap('Overlap', (compilation) => {
          compilation.hooks.processAssets.tap(
            { name: 'Overlap', stage: -10001 },
            () => frontEnd.resolve(),
          );
        });
        const release = () => {
          frontEnd.resolve();
          serverEmit.resolve();
        };
        compiler.hooks.afterEmit.tap('Overlap', release);
        compiler.hooks.failed.tap('Overlap', release);
        compiler.hooks.done.tap('Overlap', release);
      }
    },
  };
  return ['client', 'server'].map((name) => {
    const web = name === 'client';
    return {
      name,
      context: root,
      mode: 'production',
      cache: false,
      target: web ? 'web' : 'node',
      devtool: web ? 'hidden-source-map' : 'source-map',
      entry: web ? './web.js' : { a: './node-a.js', b: './node-b.js' },
      output: {
        path: path.resolve('dist', name),
        filename: '[name].[contenthash:8].js',
        chunkFilename: '[id].[contenthash:8].js',
        clean: true,
      },
      module: {
        rules: [
          {
            test: /\.c?js$/,
            use: web
              ? ['builtin:swc-loader', path.resolve('mapped-input.cjs')]
              : ['builtin:swc-loader'],
          },
          { test: /\.css$/, type: 'css' },
          { test: /\.bin$/, type: 'asset/resource', generator: { emit: web } },
        ],
      },
      optimization: {
        minimize: false,
        splitChunks: web
          ? {
              chunks: 'all',
              minSize: 0,
              maxAsyncRequests: Infinity,
              cacheGroups: {
                default: false,
                defaultVendors: false,
                packages: {
                  test: /[\\/]node_modules[\\/]unit-(?:[0-9]{1,2}|[12]\d\d|30\d)[\\/]/,
                  name(module) {
                    return 'lib-' + module.resource.match(/unit-(\d+)/)[1];
                  },
                  enforce: true,
                },
              },
            }
          : false,
      },
      plugins: [
        overlap,
        new Assets(record),
        new ModuleInputs(),
        ...(web ? [new StatsExport(record)] : []),
      ],
    };
  });
}
