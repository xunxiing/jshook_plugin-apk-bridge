# APK Bridge Plugin

`@jshookmcp/plugin-apk-bridge` is a `jshookmcp` plugin for APK static analysis on `Windows x64`.

## Features

- Bundled `Java`, `apktool`, and `jadx`
- No separate Java or APK tooling install on supported hosts
- TypeScript source in `src/manifest.ts`
- Compiled runtime entry in `manifest.js`
- `workDir`-first output layout
- Tools: `apk_check_env`, `apk_unpack`, `apk_decompile`, `apk_manifest_summary`, `apk_search_code`

## Requirements

- `Node.js >= 20`
- `Windows x64`
- A writable `jshookmcp` plugin directory

## Install

### Copy into a jshook plugin directory

`npx @jshookmcp/plugin-apk-bridge --target D:/path/to/jshook/plugins/apk-bridge --force`

Then reload extensions in `jshookmcp`.

### Global install

`npm install -g @jshookmcp/plugin-apk-bridge`

`jshook-apk-bridge --target D:/path/to/jshook/plugins/apk-bridge --force`

## Output Layout

- `apk_unpack({ inputPath, workDir })` -> `<workDir>/<apk-name>/apktool`
- `apk_decompile({ inputPath, workDir })` -> `<workDir>/<apk-name>/jadx`
- `apk_manifest_summary({ inputPath, workDir })` -> `<workDir>/<apk-name>/summary.json`
- If `workDir` is omitted, output defaults to the current working directory

## Bundled Tools

- Bundled files live in `tools/windows-x64/`
- `apk_check_env` prefers bundled binaries and only falls back to `PATH`
- `jadx` uses the bundled Java wrapper automatically
- `apktool` uses the bundled Java wrapper automatically

## Maintainer Commands

- `npm install`
- `npm run typecheck`
- `npm run build`
- `npm run prepare:tools`
- `npm run check:package`
- `npm run pack:preview`
- `npm publish --access public`

## Publish Notes

- Publish from `plugins/apk-bridge`
- Current package target is `Windows x64`
- The packed archive is large because it includes Java, `jadx`, and `apktool`
- Runtime loads `manifest.js`; source-of-truth lives in `src/manifest.ts`
