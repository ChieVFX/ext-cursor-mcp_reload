import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['src/mcp-server.ts'],
    outfile: 'dist/mcp-server.mjs',
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((config) => esbuild.context(config)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching extension and MCP server...');
} else {
  await Promise.all(builds.map((config) => esbuild.build(config)));
}
