import { build } from 'esbuild';
await build({ entryPoints: ['server/node.ts'], outfile: 'server-dist/node.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', sourcemap: true });
