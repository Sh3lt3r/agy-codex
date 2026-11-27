import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function runGit(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
}

export function isGitRepo(cwd) {
  const res = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return res.status === 0 && res.stdout.trim() === 'true';
}

function scanWorkspaceSnapshot(cwd, maxFiles = 2000) {
  const snapshot = new Map();
  const ignoreDirs = new Set(['.git', 'node_modules', '.worktrees', 'runs']);

  function walk(dir) {
    if (snapshot.size >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snapshot.size >= maxFiles) break;
      if (ignoreDirs.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          const rel = path.relative(cwd, fullPath).replace(/\\/g, '/');
          snapshot.set(rel, `${stat.size}:${stat.mtimeMs}`);
        } catch {
          // ignore
        }
      }
    }
  }

  walk(cwd);
  return snapshot;
}

export function captureBaseline(cwd) {
  const git = isGitRepo(cwd);
  const files = scanWorkspaceSnapshot(cwd);
  let head = null;
  if (git) {
    const rev = runGit(cwd, ['rev-parse', 'HEAD']);
    if (rev.status === 0) head = rev.stdout.trim();
  }
  return { git, head, files, capturedAt: new Date().toISOString() };
}

const INTERNAL_IGNORED_PREFIXES = ['runs/', '.worktrees/'];

function isInternalPath(relPath) {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return INTERNAL_IGNORED_PREFIXES.some((prefix) => norm === prefix.slice(0, -1) || norm.startsWith(prefix));
}

function parsePorcelainFiles(stdout) {
  if (!stdout) return [];
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.length >= 4)
    .map((line) => {
      const rawPath = line.slice(3).trim();
      const arrowIdx = rawPath.indexOf(' -> ');
      return (arrowIdx >= 0 ? rawPath.slice(arrowIdx + 4) : rawPath).replace(/\\/g, '/');
    })
    .filter((p) => !isInternalPath(p));
}

function runShellCommand(cwd, command, timeoutMs = 120000) {
  const isWin = process.platform === 'win32';
  const start = Date.now();
  const res = spawnSync(
    isWin ? 'powershell.exe' : '/bin/sh',
    isWin ? ['-NoProfile', '-Command', command] : ['-c', command],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    }
  );
  return {
    command,
    exitCode: res.status ?? 1,
    passed: res.status === 0,
    durationMs: Date.now() - start,
    stdout: res.stdout || '',
    stderr: res.stderr || (res.error ? res.error.message : ''),
  };
}

export function verifyWorkspace({ cwd, task, baseline = null }) {
  const git = isGitRepo(cwd);
  const currentSnapshot = scanWorkspaceSnapshot(cwd);

  const deltaFiles = [];
  if (baseline?.files) {
    for (const [rel, sig] of currentSnapshot.entries()) {
      if (baseline.files.get(rel) !== sig) {
        deltaFiles.push(rel);
      }
    }
    for (const rel of baseline.files.keys()) {
      if (!currentSnapshot.has(rel)) {
        deltaFiles.push(rel);
      }
    }
  }

  let gitChangedFiles = [];
  let diffStat = '';
  let diffText = '';

  if (git) {
    const statusRes = runGit(cwd, ['status', '--porcelain']);
    gitChangedFiles = parsePorcelainFiles(statusRes.stdout);

    const diffStatRes = runGit(cwd, ['diff', '--stat']);
    diffStat = (diffStatRes.stdout || '').trim();

    const diffRes = runGit(cwd, ['diff']);
    diffText = diffRes.stdout || '';

    // Also include contents of newly created untracked files in diffText for placeholder scanning
    for (const file of gitChangedFiles) {
      if (!diffText.includes(`b/${file}`)) {
        const full = path.join(cwd, file);
        if (fs.existsSync(full) && fs.statSync(full).isFile() && fs.statSync(full).size < 200_000) {
          const content = fs.readFileSync(full, 'utf8');
          const plusLines = content
            .split(/\r?\n/)
            .map((l) => `+${l}`)
            .join('\n');
          diffText += `\n--- /dev/null\n+++ b/${file}\n${plusLines}\n`;
        }
      }
    }
  }

  const changedFiles = Array.from(
    new Set(deltaFiles.length > 0 ? deltaFiles : gitChangedFiles)
  ).sort();

  const verifyCommands = Array.isArray(task?.verifyCommands) ? task.verifyCommands : [];
  const checks = verifyCommands.map((cmd) => runShellCommand(cwd, cmd));
  const allPassed = checks.every((c) => c.passed);

  return {
    git,
    changedFiles,
    gitChangedFiles,
    deltaFiles,
    diffStat,
    diffText,
    checks,
    allPassed,
  };
}
