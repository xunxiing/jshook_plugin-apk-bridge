import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(__dirname, '..');
const repoRoot = resolve(pluginDir, '..', '..');
const platformKey = process.platform === 'win32' && process.arch === 'x64' ? 'windows-x64' : null;

if (!platformKey) {
  throw new Error(`Unsupported platform: ${process.platform}-${process.arch}. Only win32-x64 is prepared right now.`);
}

const platformRoot = join(pluginDir, 'tools', platformKey);
const jreDir = join(platformRoot, 'jre');
const jadxDir = join(platformRoot, 'jadx');
const apktoolDir = join(platformRoot, 'apktool');
const cacheRoot = join(repoRoot, '.tools');

async function exists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resetDir(targetPath) {
  await rm(targetPath, { recursive: true, force: true });
  await mkdir(targetPath, { recursive: true });
}

async function stageJre() {
  await rm(jreDir, { recursive: true, force: true });
  const njre = require('njre');
  const normalizeLayout = async () => {
    const directJava = join(jreDir, 'bin', 'java.exe');
    if (await exists(directJava)) return;
    const entries = await readdir(jreDir, { withFileTypes: true });
    const childDirs = entries.filter((entry) => entry.isDirectory());
    if (childDirs.length !== 1) return;
    const nestedRoot = join(jreDir, childDirs[0].name);
    if (!(await exists(join(nestedRoot, 'bin', 'java.exe')))) return;
    const flattenDir = join(platformRoot, '_jre_flatten');
    await rm(flattenDir, { recursive: true, force: true });
    await cp(nestedRoot, flattenDir, { recursive: true });
    await rm(jreDir, { recursive: true, force: true });
    await cp(flattenDir, jreDir, { recursive: true });
    await rm(flattenDir, { recursive: true, force: true });
  };
  try {
    await njre.install(17, { vendor: 'eclipse', type: 'jre', installPath: jreDir });
    await normalizeLayout();
    return { source: 'njre' };
  } catch (error) {
    const fallbackDir = join(cacheRoot, 'jre-17');
    if (!(await exists(fallbackDir))) {
      throw new Error(`Failed to install JRE with njre and no fallback cache found: ${error instanceof Error ? error.message : String(error)}`);
    }
    await cp(fallbackDir, jreDir, { recursive: true });
    return { source: 'cache', warning: error instanceof Error ? error.message : String(error) };
  }
}

async function stageJadx() {
  const srcBin = join(cacheRoot, 'bin');
  const srcLib = join(cacheRoot, 'lib');
  if (!(await exists(srcBin)) || !(await exists(srcLib))) {
    throw new Error('Missing .tools/bin or .tools/lib cache for jadx');
  }
  await resetDir(jadxDir);
  await cp(srcBin, join(jadxDir, 'bin'), { recursive: true });
  await cp(srcLib, join(jadxDir, 'lib'), { recursive: true });
  await rm(join(jadxDir, 'bin', 'apktool.cmd'), { force: true });
  for (const extra of ['LICENSE', 'README.md']) {
    const extraPath = join(cacheRoot, extra);
    if (await exists(extraPath)) {
      await cp(extraPath, join(jadxDir, extra));
    }
  }
  if (process.platform === 'win32') {
    const wrapper = [
      '@echo off',
      'setlocal',
      'set "SCRIPT_DIR=%~dp0"',
      'set "JAVA_HOME=%SCRIPT_DIR%jre"',
      'set "PATH=%JAVA_HOME%\\bin;%PATH%"',
      'call "%SCRIPT_DIR%jadx\\bin\\jadx.bat" %*',
    ].join('\r\n');
    await writeFile(join(platformRoot, 'jadx.cmd'), `${wrapper}\r\n`, 'utf-8');
  }
}

async function stageApktool() {
  const srcJar = join(cacheRoot, 'apktool', 'apktool.jar');
  if (!(await exists(srcJar))) {
    throw new Error('Missing .tools/apktool/apktool.jar cache');
  }
  await resetDir(apktoolDir);
  await cp(srcJar, join(apktoolDir, 'apktool.jar'));
  const wrapper = [
    '@echo off',
    'setlocal',
    'set "SCRIPT_DIR=%~dp0"',
    'set "JAVA_EXE=%SCRIPT_DIR%..\\jre\\bin\\java.exe"',
    'if not exist "%JAVA_EXE%" (',
    '  echo Embedded Java runtime not found: %JAVA_EXE%',
    '  exit /b 1',
    ')',
    '"%JAVA_EXE%" -jar "%SCRIPT_DIR%apktool.jar" %*',
  ].join('\r\n');
  await writeFile(join(apktoolDir, 'apktool.cmd'), `${wrapper}\r\n`, 'utf-8');
}

async function detectVersion(commandPath, args) {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(commandPath, args, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });
    child.on('close', () => resolvePromise((`${stdout}\n${stderr}`).split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? 'unknown'));
    child.on('error', (error) => resolvePromise(error instanceof Error ? error.message : String(error)));
  });
}

async function main() {
  await mkdir(platformRoot, { recursive: true });
  const jre = await stageJre();
  await stageJadx();
  await stageApktool();
  const metadata = {
    platformKey,
    preparedAt: new Date().toISOString(),
    java: {
      source: jre.source,
      version: await detectVersion(join(jreDir, 'bin', 'java.exe'), ['-version']),
      warning: jre.warning ?? null,
    },
    jadx: {
      version: await detectVersion(join(platformRoot, 'jadx.cmd'), ['--version']),
    },
    apktool: {
      version: await detectVersion(join(apktoolDir, 'apktool.cmd'), ['--version']),
    },
  };
  await writeFile(join(platformRoot, 'versions.json'), JSON.stringify(metadata, null, 2), 'utf-8');
  const output = await readFile(join(platformRoot, 'versions.json'), 'utf-8');
  console.log(output);
}

await main();
