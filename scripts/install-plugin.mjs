import { access, copyFile, cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const defaultTarget = resolve(process.cwd(), 'apk-bridge');
const args = process.argv.slice(2);

function readFlag(name) {
  const exact = args.find((arg) => arg === name);
  if (exact) return true;
  return false;
}

function readOption(name) {
  const index = args.findIndex((arg) => arg === name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : null;
}

async function exists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (readFlag('--help') || readFlag('-h')) {
    console.log([
      'Usage:',
      '  jshook-apk-bridge --target <plugin-dir> [--force]',
      '',
      'Example:',
      '  npx @jshookmcp/plugin-apk-bridge --target D:/jshook/plugins/apk-bridge --force',
    ].join('\n'));
    return;
  }

  const targetDir = resolve(readOption('--target') ?? defaultTarget);
  const force = readFlag('--force');
  const sourceEntries = ['manifest.js', 'README.md', 'LICENSE', 'package.json', 'tools'];

  if (await exists(targetDir)) {
    const current = await stat(targetDir);
    if (!current.isDirectory()) {
      throw new Error(`Target exists but is not a directory: ${targetDir}`);
    }
    const targetManifest = join(targetDir, 'manifest.js');
    if ((await exists(targetManifest)) && !force) {
      throw new Error(`Target already looks like a plugin dir: ${targetDir}. Re-run with --force to overwrite.`);
    }
    if (force) {
      await rm(targetDir, { recursive: true, force: true });
    }
  }

  await mkdir(targetDir, { recursive: true });
  for (const entry of sourceEntries) {
    const source = join(packageRoot, entry);
    const destination = join(targetDir, entry);
    if (entry === 'tools') {
      await cp(source, destination, { recursive: true });
    } else {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
  }

  await writeFile(
    join(targetDir, '.installed-from-npm.json'),
    JSON.stringify(
      {
        package: '@jshookmcp/plugin-apk-bridge',
        installedAt: new Date().toISOString(),
        source: packageRoot.replace(/\\/g, '/'),
      },
      null,
      2,
    ),
    'utf-8',
  );

  console.log(JSON.stringify({ success: true, targetDir: targetDir.replace(/\\/g, '/'), nextStep: 'Reload jshook extensions after copying this directory into your plugin root.' }, null, 2));
}

await main();

