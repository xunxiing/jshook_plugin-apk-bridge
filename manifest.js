import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const PLUGIN_ID = 'local.apk-bridge';
const pluginDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = process.cwd();
const defaultOutputRoot = workspaceRoot;
const bundledToolsRoot = join(pluginDir, 'tools');
const DEP_KEY = 'apkBridgeHandlers';
const executableCache = new Map();
const toolMethodMap = {
    apk_check_env: 'handleCheckEnv',
    apk_unpack: 'handleUnpack',
    apk_decompile: 'handleDecompile',
    apk_manifest_summary: 'handleManifestSummary',
    apk_search_code: 'handleSearchCode',
};
const tools = [
    { name: 'apk_check_env', description: 'Check java, apktool, and jadx availability.', inputSchema: { type: 'object', properties: {} } },
    { name: 'apk_unpack', description: 'Unpack an APK with Apktool.', inputSchema: { type: 'object', properties: { inputPath: { type: 'string' }, workDir: { type: 'string' }, outputDir: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['inputPath'] } },
    { name: 'apk_decompile', description: 'Decompile an APK with Jadx.', inputSchema: { type: 'object', properties: { inputPath: { type: 'string' }, workDir: { type: 'string' }, outputDir: { type: 'string' }, timeoutMs: { type: 'integer' }, extraArgs: { type: 'array', items: { type: 'string' } } }, required: ['inputPath'] } },
    { name: 'apk_manifest_summary', description: 'Summarize decoded AndroidManifest.xml.', inputSchema: { type: 'object', properties: { inputPath: { type: 'string' }, workDir: { type: 'string' }, unpackDir: { type: 'string' } } } },
    { name: 'apk_search_code', description: 'Search decompiled Java or smali with compact snippets.', inputSchema: { type: 'object', properties: { inputPath: { type: 'string' }, workDir: { type: 'string' }, decompileDir: { type: 'string' }, query: { type: 'string' }, scope: { type: 'string', enum: ['java', 'smali', 'all'] }, maxResults: { type: 'integer' } }, required: ['query'] } },
];
function text(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
function fail(tool, error, extra = {}) {
    return text({ success: false, tool, error: error instanceof Error ? error.message : String(error), ...extra });
}
function bind(depKey, methodName) {
    return (deps) => async (args = {}) => deps[depKey][methodName](args ?? {});
}
function stringArg(args, key, required = false) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim())
        return value.trim();
    if (required)
        throw new Error(`${key} must be a non-empty string`);
    return undefined;
}
function intArg(args, key, fallback) {
    const value = args?.[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0)
        return value;
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value.trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0)
            return parsed;
    }
    return fallback;
}
function stringArrayArg(args, key) {
    const value = args?.[key];
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
}
function displayPath(targetPath) {
    const relativePath = relative(process.cwd(), targetPath).replace(/\\/g, '/');
    return !relativePath || relativePath.startsWith('..') ? targetPath.replace(/\\/g, '/') : relativePath;
}
function slug(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'artifact';
}
async function exists(targetPath) {
    try {
        await access(targetPath, fsConstants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function ensureDir(targetPath) {
    await mkdir(targetPath, { recursive: true });
}
async function ensureFile(targetPath, label) {
    const absolutePath = resolve(targetPath);
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat)
        throw new Error(`${label} does not exist: ${absolutePath}`);
    if (!fileStat.isFile())
        throw new Error(`${label} is not a file: ${absolutePath}`);
    return absolutePath;
}
async function ensureInputDir(targetPath, label) {
    const absolutePath = resolve(targetPath);
    const dirStat = await stat(absolutePath).catch(() => null);
    if (!dirStat)
        throw new Error(`${label} does not exist: ${absolutePath}`);
    if (!dirStat.isDirectory())
        throw new Error(`${label} is not a directory: ${absolutePath}`);
    return absolutePath;
}
async function nextDir(baseDir) {
    if (!(await exists(baseDir)))
        return baseDir;
    for (let index = 2; index <= 999; index += 1) {
        const candidate = `${baseDir}-${index}`;
        if (!(await exists(candidate)))
            return candidate;
    }
    throw new Error(`Unable to allocate output directory for ${baseDir}`);
}
function resolveWorkDir(requestedWorkDir) {
    return requestedWorkDir ? resolve(requestedWorkDir) : defaultOutputRoot;
}
function analysisRootFor(inputPath, requestedWorkDir) {
    return join(resolveWorkDir(requestedWorkDir), slug(basename(inputPath, extname(inputPath))));
}
async function resolveManagedStage(inputPath, stageName, requestedOutputDir, requestedWorkDir) {
    if (requestedOutputDir) {
        const stageDir = resolve(requestedOutputDir);
        const stageStat = await stat(stageDir).catch(() => null);
        if (stageStat && !stageStat.isDirectory())
            throw new Error(`outputDir is not a directory: ${stageDir}`);
        if (stageStat) {
            const entries = await readdir(stageDir);
            if (entries.length > 0)
                throw new Error(`outputDir already exists and is not empty: ${stageDir}`);
        }
        await ensureDir(stageDir);
        return { analysisRoot: dirname(stageDir), stageDir, managed: false };
    }
    const analysisRoot = analysisRootFor(inputPath, requestedWorkDir);
    await ensureDir(analysisRoot);
    const stageDir = await nextDir(join(analysisRoot, stageName));
    await ensureDir(stageDir);
    return { analysisRoot, stageDir, managed: true };
}
async function writeSummary(analysisRoot, patch) {
    await ensureDir(analysisRoot);
    const summaryPath = join(analysisRoot, 'summary.json');
    let base = { pluginId: PLUGIN_ID, createdAt: new Date().toISOString() };
    if (await exists(summaryPath)) {
        try {
            const parsed = JSON.parse(await readFile(summaryPath, 'utf-8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                base = parsed;
        }
        catch {
        }
    }
    const merged = {
        ...base,
        ...patch,
        outputs: { ...(base.outputs && typeof base.outputs === 'object' ? base.outputs : {}), ...(patch.outputs && typeof patch.outputs === 'object' ? patch.outputs : {}) },
        updatedAt: new Date().toISOString(),
    };
    await writeFile(summaryPath, JSON.stringify(merged, null, 2), 'utf-8');
    return summaryPath;
}
function bundledPlatformKey() {
    if (process.platform === 'win32' && process.arch === 'x64')
        return 'windows-x64';
    return null;
}
function bundledPlatformRoot() {
    const key = bundledPlatformKey();
    return key ? join(bundledToolsRoot, key) : null;
}
function bundledCommandCandidates(toolName) {
    const platformRoot = bundledPlatformRoot();
    if (!platformRoot)
        return [];
    if (toolName === 'java')
        return [join(platformRoot, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java')];
    if (toolName === 'apktool')
        return [join(platformRoot, 'apktool', process.platform === 'win32' ? 'apktool.cmd' : 'apktool')];
    if (toolName === 'jadx')
        return [process.platform === 'win32' ? join(platformRoot, 'jadx.cmd') : join(platformRoot, 'jadx', 'bin', 'jadx')];
    return [];
}
function commandCandidates(toolName) {
    const bundled = bundledCommandCandidates(toolName);
    if (toolName === 'java')
        return [...bundled, 'java'];
    if (toolName === 'apktool')
        return process.platform === 'win32' ? [...bundled, 'apktool', 'apktool.bat'] : [...bundled, 'apktool'];
    if (toolName === 'jadx')
        return process.platform === 'win32' ? [...bundled, 'jadx', 'jadx.bat'] : [...bundled, 'jadx'];
    return [...bundled, toolName];
}
function versionArgs(toolName) {
    return toolName === 'java' ? ['-version'] : ['--version'];
}
function quoteArg(value) {
    return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
async function runProcess(command, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? 300000;
    return await new Promise((resolvePromise) => {
        const startedAt = Date.now();
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let timeoutHandle = null;
        const finish = (exitCode, signal) => {
            if (settled)
                return;
            settled = true;
            if (timeoutHandle)
                clearTimeout(timeoutHandle);
            resolvePromise({ ok: exitCode === 0 && !timedOut, exitCode, signal, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
        };
        let child;
        try {
            child = spawn(command, args, { cwd: options.cwd, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (error) {
            stderr = error instanceof Error ? error.message : String(error);
            finish(1, null);
            return;
        }
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            const forceKillHandle = setTimeout(() => child.kill('SIGKILL'), 2000);
            forceKillHandle.unref?.();
        }, timeoutMs);
        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8').slice(0, 1024 * 1024 * 8); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8').slice(0, 1024 * 1024 * 2); });
        child.on('error', (error) => {
            stderr += `${stderr ? '\n' : ''}${error instanceof Error ? error.message : String(error)}`;
            finish(1, null);
        });
        child.on('close', (exitCode, signal) => finish(exitCode, signal));
    });
}
async function probe(toolName) {
    const cached = executableCache.get(toolName);
    if (cached)
        return cached;
    let lastFailure = 'command not found';
    for (const candidate of commandCandidates(toolName)) {
        const result = await runProcess(candidate, versionArgs(toolName), { timeoutMs: 10000 });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.ok) {
            const found = { available: true, command: candidate, version: output.split(/\r?\n/u).find(Boolean) ?? 'unknown' };
            executableCache.set(toolName, found);
            return found;
        }
        lastFailure = output || `exit code ${result.exitCode ?? 'unknown'}`;
    }
    const missing = { available: false, command: commandCandidates(toolName)[0], reason: lastFailure };
    executableCache.set(toolName, missing);
    return missing;
}
async function needTool(toolName) {
    const found = await probe(toolName);
    if (!found.available)
        throw new Error(`${toolName} is not available: ${found.reason ?? 'unknown error'}`);
    return found.command;
}
async function needApk(args) {
    const inputPath = await ensureFile(stringArg(args, 'inputPath', true), 'inputPath');
    if (extname(inputPath).toLowerCase() !== '.apk')
        throw new Error(`inputPath must point to an .apk file: ${inputPath}`);
    return inputPath;
}
function gather(source, regex) {
    const results = [];
    for (const match of source.matchAll(regex)) {
        if (typeof match[1] === 'string' && match[1].trim())
            results.push(match[1].trim());
    }
    return results;
}
function launcherActivity(manifestXml) {
    const patterns = [
        { tag: 'activity', regex: /<activity\b[^>]*android:name="([^"]+)"[^>]*>([\s\S]*?)<\/activity>/giu },
        { tag: 'activity-alias', regex: /<activity-alias\b[^>]*android:name="([^"]+)"[^>]*>([\s\S]*?)<\/activity-alias>/giu },
    ];
    for (const pattern of patterns) {
        for (const match of manifestXml.matchAll(pattern.regex)) {
            const name = match[1]?.trim();
            const body = match[2] ?? '';
            if (name && body.includes('android.intent.action.MAIN') && body.includes('android.intent.category.LAUNCHER')) {
                return { name, tag: pattern.tag };
            }
        }
    }
    return null;
}
function parseManifest(manifestXml) {
    const launcher = launcherActivity(manifestXml);
    return {
        packageName: manifestXml.match(/<manifest\b[^>]*\bpackage="([^"]+)"/iu)?.[1] ?? null,
        versionCode: manifestXml.match(/android:versionCode="([^"]+)"/iu)?.[1] ?? null,
        versionName: manifestXml.match(/android:versionName="([^"]+)"/iu)?.[1] ?? null,
        minSdk: manifestXml.match(/android:minSdkVersion="([^"]+)"/iu)?.[1] ?? null,
        targetSdk: manifestXml.match(/android:targetSdkVersion="([^"]+)"/iu)?.[1] ?? null,
        applicationName: manifestXml.match(/<application\b[^>]*android:name="([^"]+)"/iu)?.[1] ?? null,
        launcherActivity: launcher?.name ?? null,
        launcherTag: launcher?.tag ?? null,
        permissions: [...new Set(gather(manifestXml, /<uses-permission(?:-sdk-23)?\b[^>]*android:name="([^"]+)"/giu))],
        features: [...new Set(gather(manifestXml, /<uses-feature\b[^>]*android:name="([^"]+)"/giu))],
        componentCounts: {
            activities: gather(manifestXml, /<activity\b[^>]*android:name="([^"]+)"/giu).length,
            services: gather(manifestXml, /<service\b[^>]*android:name="([^"]+)"/giu).length,
            receivers: gather(manifestXml, /<receiver\b[^>]*android:name="([^"]+)"/giu).length,
            providers: gather(manifestXml, /<provider\b[^>]*android:name="([^"]+)"/giu).length,
        },
    };
}
async function latestStage(analysisRoot, prefix) {
    if (!(await exists(analysisRoot)))
        return null;
    const names = (await readdir(analysisRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => name === prefix || new RegExp(`^${prefix}-(\\d+)$`).test(name))
        .sort((left, right) => {
        const leftScore = left === prefix ? 1 : Number.parseInt(left.slice(prefix.length + 1), 10);
        const rightScore = right === prefix ? 1 : Number.parseInt(right.slice(prefix.length + 1), 10);
        return rightScore - leftScore;
    });
    return names.length > 0 ? join(analysisRoot, names[0]) : null;
}
async function managedStage(inputPath, prefix, requestedWorkDir) {
    return latestStage(analysisRootFor(inputPath, requestedWorkDir), prefix);
}
async function smaliRoots(unpackDir) {
    return (await readdir(unpackDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('smali'))
        .map((entry) => join(unpackDir, entry.name));
}
async function javaRoot(decompileDir) {
    const sourcesDir = join(decompileDir, 'sources');
    return (await exists(sourcesDir)) ? sourcesDir : decompileDir;
}
async function walkFiles(rootDir, visit) {
    const stack = [rootDir];
    while (stack.length > 0) {
        const current = stack.pop();
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const absolutePath = join(current, entry.name);
            if (entry.isDirectory())
                stack.push(absolutePath);
            if (entry.isFile())
                await visit(absolutePath);
        }
    }
}
function searchable(filePath, scope) {
    const extension = extname(filePath).toLowerCase();
    if (scope === 'smali')
        return extension === '.smali';
    return ['.java', '.kt', '.smali', '.xml', '.json', '.txt', '.properties', '.cfg', '.gradle'].includes(extension);
}
function snippet(line, query) {
    const lowerLine = line.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerLine.indexOf(lowerQuery);
    if (index < 0)
        return line.trim().slice(0, 240);
    return line.slice(Math.max(0, index - 60), Math.min(line.length, index + query.length + 120)).trim();
}
function createHandlers() {
    return {
        async handleCheckEnv() {
            try {
                const [javaInfo, apktoolInfo, jadxInfo] = await Promise.all([probe('java'), probe('apktool'), probe('jadx')]);
                const hasBundled = Boolean(bundledPlatformRoot());
                return text({
                    success: true,
                    tool: 'apk_check_env',
                    overallAvailable: Boolean(javaInfo.available && apktoolInfo.available && jadxInfo.available),
                    bundledPlatformRoot: bundledPlatformRoot() ? displayPath(bundledPlatformRoot()) : null,
                    tools: { java: javaInfo, apktool: apktoolInfo, jadx: jadxInfo },
                    recommendedSetup: hasBundled
                        ? [
                            'Bundled Windows x64 tools are ready to use.',
                            'You can pass workDir to keep outputs inside your chosen project directory.',
                            'PATH-based Java, Apktool, and Jadx are only used as fallback.',
                        ]
                        : [
                            'Install Java 17+ and keep java in PATH.',
                            'Install Apktool CLI and keep apktool in PATH.',
                            'Install Jadx CLI and keep jadx in PATH.',
                        ],
                });
            }
            catch (error) {
                return fail('apk_check_env', error);
            }
        },
        async handleUnpack(args) {
            try {
                const inputPath = await needApk(args);
                const timeoutMs = intArg(args, 'timeoutMs', 300000);
                const workDir = stringArg(args, 'workDir');
                const output = await resolveManagedStage(inputPath, 'apktool', stringArg(args, 'outputDir'), workDir);
                const command = await needTool('apktool');
                const commandArgs = ['d', '-f', '-o', output.stageDir, inputPath];
                const result = await runProcess(command, commandArgs, { timeoutMs });
                const manifestPath = join(output.stageDir, 'AndroidManifest.xml');
                const summaryPath = output.managed ? await writeSummary(output.analysisRoot, {
                    apk: { inputPath: displayPath(inputPath) },
                    outputs: { apktool: displayPath(output.stageDir), manifest: displayPath(manifestPath) },
                    lastRun: { tool: 'apk_unpack', success: result.ok, exitCode: result.exitCode, durationMs: result.durationMs, command: [command, ...commandArgs].map(quoteArg).join(' '), ranAt: new Date().toISOString() },
                }) : null;
                return text({
                    success: result.ok,
                    tool: 'apk_unpack',
                    inputPath: displayPath(inputPath),
                    outputDir: displayPath(output.stageDir),
                    workDir: displayPath(resolveWorkDir(workDir)),
                    manifestPath: (await exists(manifestPath)) ? displayPath(manifestPath) : null,
                    smaliDirs: (await exists(output.stageDir)) ? (await smaliRoots(output.stageDir)).map(displayPath) : [],
                    durationMs: result.durationMs,
                    exitCode: result.exitCode,
                    timedOut: result.timedOut,
                    stdout: result.stdout.slice(0, 4000),
                    stderr: result.stderr.slice(0, 4000),
                    summaryPath: summaryPath ? displayPath(summaryPath) : null,
                });
            }
            catch (error) {
                return fail('apk_unpack', error);
            }
        },
        async handleDecompile(args) {
            try {
                const inputPath = await needApk(args);
                const timeoutMs = intArg(args, 'timeoutMs', 600000);
                const workDir = stringArg(args, 'workDir');
                const output = await resolveManagedStage(inputPath, 'jadx', stringArg(args, 'outputDir'), workDir);
                const command = await needTool('jadx');
                const commandArgs = ['-d', output.stageDir, ...stringArrayArg(args, 'extraArgs'), inputPath];
                const result = await runProcess(command, commandArgs, { timeoutMs });
                const sourcesPath = await javaRoot(output.stageDir);
                const hasUsableOutput = await exists(sourcesPath);
                const effectiveSuccess = result.ok || hasUsableOutput;
                const summaryPath = output.managed ? await writeSummary(output.analysisRoot, {
                    apk: { inputPath: displayPath(inputPath) },
                    outputs: { jadx: displayPath(output.stageDir), jadxSources: displayPath(sourcesPath) },
                    lastRun: { tool: 'apk_decompile', success: effectiveSuccess, exitCode: result.exitCode, durationMs: result.durationMs, command: [command, ...commandArgs].map(quoteArg).join(' '), ranAt: new Date().toISOString() },
                }) : null;
                return text({
                    success: effectiveSuccess,
                    tool: 'apk_decompile',
                    inputPath: displayPath(inputPath),
                    outputDir: displayPath(output.stageDir),
                    workDir: displayPath(resolveWorkDir(workDir)),
                    javaRoot: hasUsableOutput ? displayPath(sourcesPath) : null,
                    partialOutput: hasUsableOutput && !result.ok,
                    durationMs: result.durationMs,
                    exitCode: result.exitCode,
                    timedOut: result.timedOut,
                    stdout: result.stdout.slice(0, 4000),
                    stderr: result.stderr.slice(0, 4000),
                    summaryPath: summaryPath ? displayPath(summaryPath) : null,
                });
            }
            catch (error) {
                return fail('apk_decompile', error);
            }
        },
        async handleManifestSummary(args) {
            try {
                const unpackDirArg = stringArg(args, 'unpackDir');
                const inputPathArg = stringArg(args, 'inputPath');
                let unpackDir;
                if (unpackDirArg) {
                    unpackDir = await ensureInputDir(unpackDirArg, 'unpackDir');
                }
                else if (inputPathArg) {
                    unpackDir = await managedStage(resolve(inputPathArg), 'apktool', stringArg(args, 'workDir'));
                    if (!unpackDir)
                        throw new Error(`No managed apktool output found for ${resolve(inputPathArg)}. Run apk_unpack first or pass unpackDir.`);
                }
                else {
                    throw new Error('Either inputPath or unpackDir is required');
                }
                const manifestPath = await ensureFile(join(unpackDir, 'AndroidManifest.xml'), 'AndroidManifest.xml');
                const summary = parseManifest(await readFile(manifestPath, 'utf-8'));
                const summaryPath = await writeSummary(dirname(unpackDir), {
                    manifestSummary: summary,
                    outputs: { manifest: displayPath(manifestPath) },
                    lastRun: { tool: 'apk_manifest_summary', success: true, ranAt: new Date().toISOString() },
                });
                return text({ success: true, tool: 'apk_manifest_summary', unpackDir: displayPath(unpackDir), manifestPath: displayPath(manifestPath), summary, summaryPath: displayPath(summaryPath) });
            }
            catch (error) {
                return fail('apk_manifest_summary', error);
            }
        },
        async handleSearchCode(args) {
            try {
                const query = stringArg(args, 'query', true);
                const inputPathArg = stringArg(args, 'inputPath');
                const decompileDirArg = stringArg(args, 'decompileDir');
                const scope = stringArg(args, 'scope') ?? 'all';
                if (!['java', 'smali', 'all'].includes(scope))
                    throw new Error('scope must be one of: java, smali, all');
                const maxResults = Math.min(intArg(args, 'maxResults', 50), 200);
                const warnings = [];
                const roots = [];
                const queryLower = query.toLowerCase();
                if (scope === 'java' || scope === 'all') {
                    if (decompileDirArg) {
                        roots.push({ scope: 'java', root: await javaRoot(await ensureInputDir(decompileDirArg, 'decompileDir')) });
                    }
                    else if (inputPathArg) {
                        const stage = await managedStage(resolve(inputPathArg), 'jadx', stringArg(args, 'workDir'));
                        if (stage)
                            roots.push({ scope: 'java', root: await javaRoot(stage) });
                        else
                            warnings.push('No managed JADX output found. Run apk_decompile first or pass decompileDir.');
                    }
                }
                if (scope === 'smali' || scope === 'all') {
                    if (!inputPathArg) {
                        warnings.push('Smali search needs inputPath so the plugin can locate managed apktool output.');
                    }
                    else {
                        const stage = await managedStage(resolve(inputPathArg), 'apktool', stringArg(args, 'workDir'));
                        if (stage) {
                            for (const root of await smaliRoots(stage))
                                roots.push({ scope: 'smali', root });
                        }
                        else {
                            warnings.push('No managed Apktool output found. Run apk_unpack first to search smali.');
                        }
                    }
                }
                const uniqueRoots = [];
                const seen = new Set();
                for (const item of roots) {
                    const key = `${item.scope}:${item.root}`;
                    if (!seen.has(key) && (await exists(item.root))) {
                        seen.add(key);
                        uniqueRoots.push(item);
                    }
                }
                if (uniqueRoots.length === 0)
                    throw new Error(`No searchable roots found for scope=${scope}`);
                const hits = [];
                let filesScanned = 0;
                for (const item of uniqueRoots) {
                    await walkFiles(item.root, async (filePath) => {
                        if (hits.length >= maxResults)
                            return;
                        if (!searchable(filePath, item.scope))
                            return;
                        const fileStat = await stat(filePath);
                        if (fileStat.size > 1024 * 1024)
                            return;
                        let content;
                        try {
                            content = await readFile(filePath, 'utf-8');
                        }
                        catch {
                            return;
                        }
                        filesScanned += 1;
                        const lines = content.split(/\r?\n/u);
                        for (let index = 0; index < lines.length; index += 1) {
                            if (lines[index].toLowerCase().includes(queryLower)) {
                                hits.push({ scope: item.scope, file: displayPath(filePath), line: index + 1, snippet: snippet(lines[index], query) });
                                if (hits.length >= maxResults)
                                    break;
                            }
                        }
                    });
                    if (hits.length >= maxResults)
                        break;
                }
                let summaryPath = null;
                if (inputPathArg) {
                    summaryPath = await writeSummary(analysisRootFor(resolve(inputPathArg), stringArg(args, 'workDir')), {
                        searchSummary: { query, scope, hitCount: hits.length, filesScanned, searchedRoots: uniqueRoots.map((item) => displayPath(item.root)) },
                        lastRun: { tool: 'apk_search_code', success: true, ranAt: new Date().toISOString() },
                    });
                }
                return text({ success: true, tool: 'apk_search_code', query, scope, maxResults, filesScanned, hitCount: hits.length, searchedRoots: uniqueRoots.map((item) => ({ scope: item.scope, root: displayPath(item.root) })), warnings, hits, summaryPath: summaryPath ? displayPath(summaryPath) : null });
            }
            catch (error) {
                return fail('apk_search_code', error);
            }
        },
    };
}
const apkDomain = {
    kind: 'domain-manifest',
    version: 1,
    domain: 'apk',
    depKey: DEP_KEY,
    profiles: ['workflow', 'full'],
    ensure() {
        return createHandlers();
    },
    registrations: tools.map((tool) => ({ tool, domain: 'apk', bind: bind(DEP_KEY, toolMethodMap[tool.name]) })),
};
const plugin = {
    manifest: {
        kind: 'plugin-manifest',
        version: 1,
        id: PLUGIN_ID,
        name: 'APK Bridge',
        pluginVersion: '0.2.0',
        entry: 'manifest.js',
        description: 'Static APK bridge for unpacking, decompiling, manifest summaries, and low-token search.',
        compatibleCore: '>=0.1.0',
        permissions: {
            network: { allowHosts: [] },
            process: { allowCommands: ['java', 'java.exe', 'apktool', 'apktool.bat', 'apktool.cmd', 'jadx', 'jadx.bat', 'jadx.cmd'] },
            filesystem: { readRoots: [pluginDir, workspaceRoot, bundledToolsRoot], writeRoots: [workspaceRoot, bundledToolsRoot] },
            toolExecution: { allowTools: [] },
        },
        activation: { onStartup: true, profiles: ['workflow', 'full'] },
        contributes: {
            domains: [apkDomain],
            workflows: [],
            configDefaults: {
                'plugins.apk-bridge.enabled': true,
                'plugins.apk-bridge.outputRoot': defaultOutputRoot.replace(/\\/g, '/'),
                'plugins.apk-bridge.toolRoot': bundledToolsRoot.replace(/\\/g, '/'),
            },
            metrics: [],
        },
    },
    onLoad(ctx) {
        ctx.setRuntimeData('loadedAt', new Date().toISOString());
    },
    onValidate(ctx) {
        return ctx.getConfig('plugins.apk-bridge.enabled', true) ? { valid: true, errors: [] } : { valid: false, errors: ['Plugin disabled by config'] };
    },
    onRegister(ctx) {
        ctx.registerDomain(apkDomain);
    },
};
export default plugin;
