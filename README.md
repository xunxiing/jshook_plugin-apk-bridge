# APK Bridge Plugin

Local `jshookmcp` plugin for APK static analysis.

Current bundle target: `Windows x64`.

The plugin ships with bundled:

- Java runtime (`njre`-compatible JRE layout)
- `jadx`
- `apktool`

So end users do not need to install Java, Jadx, or Apktool separately on supported platforms.

## Tools

- `apk_check_env`
- `apk_unpack`
- `apk_decompile`
- `apk_manifest_summary`
- `apk_search_code`

## Output behavior

- Prefer passing `workDir` to `apk_unpack` and `apk_decompile`
- If `outputDir` is omitted, output goes to `<workDir>/<apk-name>/apktool` and `<workDir>/<apk-name>/jadx`
- If `workDir` is omitted, output defaults to the current working directory
- `summary.json` is written under `<workDir>/<apk-name>/summary.json`

## Bundled tools

- Bundled tools live under `tools/windows-x64/`
- `apk_check_env` prefers bundled binaries first, then falls back to `PATH`
- `jadx` is wrapped so it automatically uses the bundled Java runtime
- `apktool` is wrapped so it automatically uses the bundled Java runtime

## Packaging

- Plugin package metadata lives in `package.json`
- Refresh bundled dependencies with `npm run prepare:tools`
- Recommended publish flow is to publish from `plugins/apk-bridge/`

## Example

- `apk_unpack({ inputPath: 'D:/path/app.apk', workDir: 'D:/work/apk-analysis' })`
- `apk_decompile({ inputPath: 'D:/path/app.apk', workDir: 'D:/work/apk-analysis' })`
