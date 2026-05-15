import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const vsixPath = path.join(root, `${pkg.name}-${pkg.version}.vsix`);

if (!fs.existsSync(vsixPath)) {
  console.error(`Missing VSIX: ${vsixPath}`);
  console.error('Run npm run package first.');
  process.exit(1);
}

const args = ['--install-extension', vsixPath, ...process.argv.slice(2)];
const result = spawnSync('cursor', args, {
  cwd: root,
  env: {
    ...process.env,
    NODE_NO_WARNINGS: '1',
  },
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
