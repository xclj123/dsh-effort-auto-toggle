#!/usr/bin/env node
/**
 * Install / remove dsh-effort-auto-toggle in ONE named DSH profile.
 *
 * Nothing is guessed: you have to name the profile directory, and the live
 * desktop profile is refused unless you pass --i-know-what-im-doing. Every
 * file it rewrites is backed up next to itself first.
 *
 *   node tools/install.mjs --profile "C:/Users/me/.dsh/profiles/lab"
 *   node tools/install.mjs --profile "C:/Users/me/.dsh/profiles/lab" --remove
 *   node tools/install.mjs --profile "..." --dry-run
 *
 * Options:
 *   --profile <dir>   target profile directory (must contain package.json)
 *   --minimax-key <k> write a MiniMax key into the config (mode stays minimax)
 *   --minimax-url <u>  scorer endpoint   --minimax-model <m> scorer model
 *   --bundle          also add the package into dsh.profile.bundles (default off: like adaptive-effort)
 *   --mode <m>        minimax | heuristic            (default heuristic)
 *   --force           also allowed for a profile named "desktop"
 *   --remove          uninstall instead of install
 *   --dry-run         print the plan, write nothing
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PKG = 'dsh-effort-auto-toggle';
const NL = String.fromCharCode(10);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COPY = ['lib', 'package.json', 'cordis.patch.yml', 'index.d.ts', 'README.md', 'README_EN.md', 'LICENSE'];
const YAML_MARK = '# ── dsh-effort-auto-toggle';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const profile = opt('--profile');
if (!profile) {
  // Cross-platform auto-discovery: ~/.dsh/profiles/<name>
  const profilesRoot = join(homedir(), '.dsh', 'profiles');
  if (existsSync(profilesRoot)) {
    const found = readdirSync(profilesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(profilesRoot, e.name, 'package.json')))
      .map((e) => join(profilesRoot, e.name));
    if (found.length) {
      console.error('no --profile given; profiles found under ' + profilesRoot + ':');
      for (const f of found) console.error('  --profile "' + f + '"');
      process.exit(2);
    }
  }
  console.error('missing --profile <dir> (no profiles found under ' + profilesRoot + ')'); process.exit(2);
}
const profileDir = resolve(profile);
const pkgPath = join(profileDir, 'package.json');
const yamlPath = join(profileDir, 'cordis.patch.yml');
const dryRun = flag('--dry-run');
const remove = flag('--remove');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

if (!existsSync(pkgPath)) { console.error(`not a dsh profile (no package.json): ${profileDir}`); process.exit(2); }
if (basename(profileDir) === 'desktop' && !flag('--force')) {
  console.error('refusing the live "desktop" profile (pass --force only when that is really what you want)');
  process.exit(3);
}

const read = (p) => readFileSync(p, 'utf8');
const writeAtomic = (p, text) => {
  const tmp = `${p}.tmp-install`;
  writeFileSync(tmp, text);
  renameSync(tmp, p);
};
const backup = (p) => {
  if (!existsSync(p)) return;
  const to = `${p}.bak-efforttoggle-${stamp}`;
  copyFileSync(p, to);
  console.log(`  backup ${to}`);
};

const KEY = JSON.stringify(PKG);

/**
 * Line-based package.json surgery: keeps the file's own formatting instead of
 * re-serialising it (a re-serialise would rewrite the whole manifest).
 */
function patchPackageJson(text, adding, version, addBundle) {
  const lines = text.split(NL);
  const isOurs = (line) => line.trim().startsWith(KEY);
  if (adding) {
    const existing = lines.find(isOurs);
    if (existing !== undefined) {
      const bumped = existing.replace(/:\s*"[^"]*"\s*(,?)\s*$/, `: "${version}"$1`);
      return lines.map((l) => (l === existing ? bumped : l)).join(NL);
    }
    const out = [];
    const inline = (line, open, close, entry) => {
      // handles the one-line form "key": {}  /  "key": []
      const at = line.indexOf(open);
      const flat = open + ' ' + entry + ' ' + close;
      return line.slice(0, at) + flat + line.slice(at + 2);
    };
    for (const line of lines) {
      const depLine = line.includes('"dependencies"') && line.includes('{');
      const bundleLine = addBundle && line.includes('"bundles"') && line.includes('[');
      if (depLine && line.includes('}')) {
        out.push(inline(line, '{', '}', KEY + ': "' + version + '"'));
      } else if (bundleLine && line.includes(']')) {
        out.push(inline(line, '[', ']', KEY));
      } else {
        out.push(line);
        if (depLine) out.push('    ' + KEY + ': "' + version + '",');
        else if (bundleLine) out.push('        ' + KEY + ',');
      }
    }
    const patched = out.join(NL);
    JSON.parse(patched); // fail loud before anything is written
    return patched;
  }
  const kept = lines.filter((line) => !isOurs(line));
  const patched = dropDanglingCommas(kept).join(NL);
  JSON.parse(patched);
  return patched;
}

/** Remove a comma that would otherwise sit right before a closing bracket. */
function dropDanglingCommas(lines) {
  const out = lines.slice();
  for (let i = 0; i < out.length; i += 1) {
    const line = out[i];
    if (!line.trimEnd().endsWith(',')) continue;
    let j = i + 1;
    while (j < out.length && out[j].trim() === '') j += 1;
    if (j >= out.length) continue;
    const next = out[j].trim().charAt(0);
    if (next === ']' || next === '}') out[i] = line.trimEnd().slice(0, -1);
  }
  return out;
}

function patchYaml(text, adding, config) {
  const lines = text.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isMarker = line.startsWith(YAML_MARK) || line.startsWith(`- id: ${PKG}`);
    const isBlockComment = line.startsWith('# 入口：') || line.startsWith('# 点亮 =');
    if (isMarker || isBlockComment) {
      i += 1;
      while (i < lines.length && (lines[i].startsWith(' ') || lines[i].trim() === '')) i += 1;
      i -= 1;
      continue;
    }
    kept.push(line);
  }
  if (!adding) return trimBlanks(kept).join('\n') + '\n';
  const block = [
    '',
    `${YAML_MARK}（adaptive-effort 的按钮开关版 fork）─────────`,
    '# 入口：输入栏「自动」按钮（conversation.input.right 插槽，模型选择器左侧）。',
    '# 点亮 = 按当前模型真实档位表自动调度（如 low/high/max 或 low/high/highx/max/ultra）；熄灭 = 人工选择。',
    '# 按钮与消息角标显示档位原文（英文），数据来自 modelSelection 会话投影。',
    `- id: ${PKG}`,
    `  name: ${PKG}`,
    '  config:',
    `    autoOn: ${config.autoOn}`,
    `    mode: ${config.mode}`,
  ];
  if (config.minimaxApiKey) block.push('    minimaxApiKey: "' + config.minimaxApiKey + '"');
  if (config.minimaxBaseUrl) block.push('    minimaxBaseUrl: ' + config.minimaxBaseUrl);
  if (config.minimaxModel) block.push('    minimaxModel: ' + config.minimaxModel);
  const head = trimBlanks(kept).join('\n');
  return `${head}\n${block.join('\n')}\n`;
}

/** Drop trailing blank lines and collapse runs of 3+ blanks into one. */
function trimBlanks(lines) {
  const out = [];
  for (const line of lines) {
    if (line.trim() === '' && out.length > 0 && out[out.length - 1].trim() === '') continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

// -- main -------------------------------------------------------------------
const version = JSON.parse(read(join(ROOT, 'package.json'))).version;
const target = join(profileDir, 'node_modules', PKG);
const carriedAutoOn = (() => {
  if (!existsSync(yamlPath)) return 'false';
  const m = read(yamlPath).match(/autoOn:\s*(true|false)/);
  return m ? m[1] : 'false';
})();
const config = {
  autoOn: String(opt('--auto-on', carriedAutoOn)) === 'true',
  mode: opt('--mode', 'minimax'),
  minimaxApiKey: opt('--minimax-key', ''),
  minimaxBaseUrl: opt('--minimax-url', ''),
  minimaxModel: opt('--minimax-model', ''),
};
if (!['minimax', 'heuristic'].includes(config.mode)) { console.error(`bad --mode ${config.mode}`); process.exit(2); }
if (config.mode === 'minimax' && !config.minimaxApiKey) config.mode = 'heuristic';

console.log(`${remove ? 'removing' : `installing ${PKG}@${version} in`} ${profileDir}${dryRun ? '  (dry run)' : ''}`);

if (remove) {
  if (existsSync(target)) {
    console.log(`  rm -rf ${target}`);
    if (!dryRun) rmSync(target, { recursive: true, force: true });
  }
  for (const [path, patch] of [
    [pkgPath, (t) => patchPackageJson(t, false, version)],
    [yamlPath, (t) => patchYaml(t, false, config)],
  ]) {
    if (!existsSync(path)) continue;
    const next = patch(read(path));
    if (next === read(path)) continue;
    console.log(`  ${path} cleaned`);
    if (!dryRun) { backup(path); writeAtomic(path, next); }
  }
} else {
  const files = COPY.filter((name) => existsSync(join(ROOT, name)));
  console.log(`  copy ${files.join(', ')} -> node_modules/${PKG}/`);
  if (!dryRun) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const name of files) {
      const from = join(ROOT, name);
      const to = join(target, name);
      if (statSync(from).isDirectory()) {
        mkdirSync(to, { recursive: true });
        for (const entry of readdirSync(from)) {
          if (entry.startsWith('.')) continue;
          copyFileSync(join(from, entry), join(to, entry));
        }
      } else {
        copyFileSync(from, to);
      }
    }
  }
  for (const [path, patch] of [
    [pkgPath, (t) => patchPackageJson(t, true, version, flag('--bundle'))],
    [yamlPath, (t) => patchYaml(t, true, config)],
  ]) {
    const before = existsSync(path) ? read(path) : '';
    const next = patch(before);
    if (next === before) { console.log(`  ${path} already up to date`); continue; }
    console.log(`  ${path} patched`);
    if (!dryRun) { backup(path); writeAtomic(path, next); }
  }
}

console.log(dryRun ? 'dry run finished — nothing written' : 'done — restart the DSH instance that owns this profile (or let hot reload pick it up)');
