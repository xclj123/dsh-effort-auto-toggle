#!/usr/bin/env node
/**
 * Repo self-check for dsh-effort-auto-toggle.
 *
 * The plugin ships hand-written JavaScript plus hand-written `.d.ts` files, and
 * its runtime files are listed explicitly in `package.json#files`. Three things
 * therefore drift silently unless something looks at them:
 *
 *   1. a `lib/*.js` module whose `.d.ts` is missing or stale (exports differ);
 *   2. a runtime file that never makes it into the packed tarball;
 *   3. a regressed `readEvents()` — the only place allowed to touch
 *      `session.events`, and only as the last fallback.
 *
 * Exits non-zero on the first category of drift found. No dependencies.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const libDir = join(root, 'lib');
const failures = [];
const notes = [];

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const jsFiles = readdirSync(libDir).filter((name) => name.endsWith('.js')).sort();

/** Names a module exports at runtime: `export function/class/const/let x`. */
function exportedNames(source) {
    const names = new Set();
    const patterns = [
        /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
        /^export\s+class\s+([A-Za-z_$][\w$]*)/gm,
        /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) names.add(match[1]);
    }
    return names;
}

/** Names a declaration file declares: `export declare function/class/const x`. */
function declaredNames(source) {
    const names = new Set();
    const patterns = [
        /^export\s+declare\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
        /^export\s+declare\s+class\s+([A-Za-z_$][\w$]*)/gm,
        /^export\s+declare\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) names.add(match[1]);
    }
    return names;
}

/**
 * Modules shipped without a declaration file on purpose. `client.js` is the
 * browser bundle: it is loaded through the host module loader, never imported
 * from a TypeScript context, so it declares nothing.
 */
const NO_DECLARATIONS = new Set(['client']);

/** Drop `//` and block comments so prose about an API is not read as a call. */
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// 1. every runtime module has an up-to-date declaration file
for (const file of jsFiles) {
    const base = file.slice(0, -3);
    if (NO_DECLARATIONS.has(base)) continue;
    const dts = join(libDir, `${base}.d.ts`);
    if (!existsSync(dts)) {
        failures.push(`lib/${file}: missing lib/${base}.d.ts`);
        continue;
    }
    const atRuntime = exportedNames(readFileSync(join(libDir, file), 'utf8'));
    const declared = declaredNames(readFileSync(dts, 'utf8'));
    for (const name of atRuntime) {
        if (!declared.has(name)) failures.push(`lib/${base}.d.ts: missing declaration for ${name}`);
    }
    for (const name of declared) {
        if (!atRuntime.has(name)) failures.push(`lib/${base}.d.ts: declares ${name}, which lib/${file} does not export`);
    }
}

// 2. the packed tarball must carry every runtime file (and the docs it links)
const files = Array.isArray(pkg.files) ? pkg.files : [];
const packed = new Set(files);
for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'README_EN.md', 'CHANGELOG.md', 'LICENSE']) {
    if (!packed.has(entry)) failures.push(`package.json#files: missing "${entry}"`);
}
if (typeof pkg.types === 'string' && !existsSync(join(root, pkg.types))) {
    failures.push(`package.json#types: ${pkg.types} does not exist`);
}
if (pkg.dsh?.bundle?.patch !== undefined && !existsSync(join(root, pkg.dsh.bundle.patch))) {
    failures.push(`package.json#dsh.bundle.patch: ${pkg.dsh.bundle.patch} does not exist`);
}
if (pkg.exports?.['./client']?.default !== undefined && !existsSync(join(root, pkg.exports['./client'].default))) {
    failures.push(`package.json#exports["./client"]: ${pkg.exports['./client'].default} does not exist`);
}

// 3. session event reads stay behind the four-step probe
const host = stripComments(readFileSync(join(libDir, 'index.js'), 'utf8'));
const probe = host.slice(host.indexOf('function readEvents('), host.indexOf('function readEvents(') + 1600);
for (const api of ['snapshotEvents', 'ownEvents', 'eventAt', 'events']) {
    if (!probe.includes(api)) failures.push(`lib/index.js readEvents(): no "${api}" step in the probe`);
}
for (const file of jsFiles.filter((name) => name !== 'index.js')) {
    if (/(?:^|[^.\w])session\.events\b/.test(stripComments(readFileSync(join(libDir, file), 'utf8')))) {
        failures.push(`lib/${file}: reads session.events directly (only readEvents() may)`);
    }
}

// 4. versions the host matrix claims must at least be self-consistent
if (typeof pkg.engines?.dsh !== 'string') notes.push('package.json#engines.dsh: not declared');

if (notes.length > 0) {
    for (const note of notes) process.stdout.write(`note  ${note}\n`);
}
if (failures.length > 0) {
    for (const failure of failures) process.stdout.write(`FAIL  ${failure}\n`);
    process.stdout.write(`\n${failures.length} problem(s).\n`);
    process.exit(1);
}
process.stdout.write(`ok  ${jsFiles.length} runtime modules, ${files.length} packed entries, readEvents() probe intact\n`);
