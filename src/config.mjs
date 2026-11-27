import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const TOOL_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_CONFIG = {
  codex: {
    bin: 'auto',
    model: '',
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    fullAuto: false,
    extraArgs: [],
    promptDelivery: 'stdin',
    timeoutMs: 600000,
  },
  orchestrator: {
    maxAttempts: 3,
    autoResumeOnEvasion: true,
    autoResumeOnVerifyFail: true,
    strictAntiEvasion: true,
    runsDir: 'runs',
    worktreesDir: '.worktrees',
    defaultConcurrency: 2,
  },
  antiEvasion: {
    blockingScoreThreshold: 35,
    warningScoreThreshold: 15,
    requireReceipt: true,
    checkDiffPlaceholders: true,
  },
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export function loadConfig(configPath) {
  const candidates = [
    configPath,
    path.join(process.cwd(), 'config', 'agy-codex.config.json'),
    path.join(TOOL_ROOT, 'config', 'agy-codex.config.json'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        config: deepMerge(DEFAULT_CONFIG, parsed),
        configPath: candidate,
      };
    }
  }

  return {
    config: structuredClone(DEFAULT_CONFIG),
    configPath: null,
  };
}

export function resolveCodexBinary(configuredBin = 'auto') {
  const envBin = process.env.CODEX_BIN;
  const preferred = envBin || (configuredBin && configuredBin !== 'auto' ? configuredBin : null);

  if (preferred) {
    if (fs.existsSync(preferred)) {
      return { found: true, path: preferred, source: envBin ? 'env:CODEX_BIN' : 'config' };
    }
    const probe = probeCommandOnPath(preferred);
    if (probe) {
      return { found: true, path: probe, source: envBin ? 'env:CODEX_BIN' : 'config' };
    }
    return {
      found: false,
      path: preferred,
      source: envBin ? 'env:CODEX_BIN' : 'config',
      checked: [preferred],
    };
  }

  const onPath = probeCommandOnPath('codex');
  if (onPath) {
    return { found: true, path: onPath, source: 'PATH' };
  }

  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const npmPrefix = probeNpmPrefix();

  const candidates = [
    npmPrefix && path.join(npmPrefix, 'codex.cmd'),
    npmPrefix && path.join(npmPrefix, 'codex.exe'),
    npmPrefix && path.join(npmPrefix, 'codex'),
    path.join(appData, 'npm', 'codex.cmd'),
    path.join(appData, 'npm', 'codex.exe'),
    path.join(localAppData, 'pnpm', 'codex.cmd'),
    path.join(localAppData, 'Volta', 'bin', 'codex.cmd'),
    path.join(home, '.npm-global', 'codex.cmd'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.cargo', 'bin', 'codex.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { found: true, path: candidate, source: 'auto-detected', checked: candidates };
    }
  }

  return {
    found: false,
    path: null,
    source: 'not-found',
    checked: candidates,
  };
}

function probeCommandOnPath(cmd) {
  const isWin = process.platform === 'win32';
  const lookup = isWin ? 'where.exe' : 'which';
  const res = spawnSync(lookup, [cmd], { encoding: 'utf8', windowsHide: true });
  if (res.status === 0 && res.stdout) {
    const lines = res.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    if (isWin) {
      const preferred =
        lines.find((l) => l.toLowerCase().endsWith('.exe')) ||
        lines.find((l) => l.toLowerCase().endsWith('.cmd')) ||
        lines[0];
      return preferred;
    }
    return lines[0];
  }
  return null;
}

function probeNpmPrefix() {
  const isWin = process.platform === 'win32';
  const res = isWin
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm config get prefix'], {
        encoding: 'utf8',
        windowsHide: true,
      })
    : spawnSync('npm', ['config', 'get', 'prefix'], {
        encoding: 'utf8',
        windowsHide: true,
      });
  if (res.status === 0 && res.stdout) {
    const val = res.stdout.trim();
    if (val && val !== 'undefined') return val;
  }
  return null;
}
