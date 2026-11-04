import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const localGo = path.join(root, '.tools', 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
const go = process.env.GO_BINARY || (existsSync(localGo) ? localGo : 'go');
const result = spawnSync(go, ['tool', 'mygo', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    GOPATH: process.env.GOPATH || path.join(root, '.tools', 'gopath'),
    GOCACHE: process.env.GOCACHE || path.join(root, '.tools', 'gocache'),
  },
});
if (result.error) {
  console.error(`Cannot run Go: ${result.error.message}. Install Go 1.27.3 or newer, or set GO_BINARY.`);
}
process.exitCode = result.status ?? 1;
