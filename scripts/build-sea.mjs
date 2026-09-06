import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const projectRoot = process.cwd();
const distDir = path.resolve(projectRoot, 'dist');
fs.mkdirSync(distDir, { recursive: true });

console.log('[build:sea] Step 1: Bundling TypeScript into dist/bundle.cjs via esbuild...');
esbuild.buildSync({
  entryPoints: [path.resolve(projectRoot, 'src/bin.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: path.join(distDir, 'bundle.cjs'),
  external: ['node:*'],
  sourcemap: 'inline',
});

console.log('[build:sea] Step 2: Generating SEA configuration and preparation blob...');
const seaConfigFile = path.join(distDir, 'sea-config.json');
const seaPrepBlob = path.join(distDir, 'sea-prep.blob');
const seaConfig = {
  main: path.join(distDir, 'bundle.cjs'),
  output: seaPrepBlob,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
};
fs.writeFileSync(seaConfigFile, JSON.stringify(seaConfig, null, 2));

execFileSync(process.execPath, ['--experimental-sea-config', seaConfigFile], {
  stdio: 'inherit',
  cwd: projectRoot,
});

console.log('[build:sea] Step 3: Copying host Node binary...');
const targetBinary = path.join(distDir, 'obsidian-livesync-headless');
if (fs.existsSync(targetBinary)) {
  fs.unlinkSync(targetBinary);
}
fs.copyFileSync(process.execPath, targetBinary);
fs.chmodSync(targetBinary, 0o755);

console.log('[build:sea] Step 4: Injecting SEA blob into standalone binary using postject...');
const postjectBin = path.resolve(projectRoot, 'node_modules/.bin/postject');
const postjectArgs = [
  targetBinary,
  'NODE_SEA_BLOB',
  seaPrepBlob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--overwrite',
];

if (process.platform === 'darwin') {
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}

execFileSync(postjectBin, postjectArgs, {
  stdio: 'inherit',
  cwd: projectRoot,
});

fs.chmodSync(targetBinary, 0o755);
console.log(`[build:sea] Successfully packaged standalone executable at: ${targetBinary}`);
