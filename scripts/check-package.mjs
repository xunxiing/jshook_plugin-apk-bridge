import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const requiredPaths = [
  'src/manifest.ts',
  'tsconfig.json',
  'manifest.js',
  'README.md',
  'LICENSE',
  'tools/windows-x64/versions.json',
  'tools/windows-x64/jre/bin/java.exe',
  'tools/windows-x64/apktool/apktool.jar',
  'tools/windows-x64/apktool/apktool.cmd',
  'tools/windows-x64/jadx/lib/jadx-1.5.5-all.jar',
  'tools/windows-x64/jadx/bin/jadx.bat',
  'tools/windows-x64/jadx.cmd'
];

async function ensureFile(relativePath) {
  const absolutePath = join(packageRoot, relativePath);
  await access(absolutePath, fsConstants.F_OK);
  return absolutePath;
}

for (const relativePath of requiredPaths) {
  await ensureFile(relativePath);
}

const versions = JSON.parse(await readFile(join(packageRoot, 'tools/windows-x64/versions.json'), 'utf-8'));
if (!versions?.java?.version || !versions?.jadx?.version || !versions?.apktool?.version) {
  throw new Error('versions.json is missing expected tool version fields');
}

console.log(JSON.stringify({
  success: true,
  packageRoot: packageRoot.replace(/\\/g, '/'),
  versions,
}, null, 2));
