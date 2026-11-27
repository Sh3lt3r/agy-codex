import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isGitRepo } from './verifier.mjs';

function runGit(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

export function createWorktree({ repoDir, worktreesDir, runId, baseRef = 'HEAD' }) {
  if (!isGitRepo(repoDir)) {
    throw new Error(`Cannot create worktree: "${repoDir}" is not a git repository.`);
  }

  const headCheck = runGit(repoDir, ['rev-parse', '--verify', baseRef]);
  if (headCheck.status !== 0) {
    throw new Error(
      `Cannot create worktree: base ref "${baseRef}" does not exist (make an initial commit first).`
    );
  }

  const safeId = runId.replace(/[^a-zA-Z0-9._-]/g, '-');
  const branchName = `agy-codex/${safeId}`;
  const worktreePath = path.resolve(repoDir, worktreesDir, safeId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  const addRes = runGit(repoDir, ['worktree', 'add', '-b', branchName, worktreePath, baseRef]);
  if (addRes.status !== 0) {
    throw new Error(`Failed to create git worktree: ${addRes.stderr || addRes.stdout}`);
  }

  return {
    repoDir,
    worktreePath,
    branchName,
    baseRef,
  };
}

export function cleanupWorktree({ repoDir, worktreePath, branchName = null, deleteBranch = false }) {
  if (!worktreePath) return { removed: false };
  const res = runGit(repoDir, ['worktree', 'remove', '--force', worktreePath]);
  if (deleteBranch && branchName) {
    runGit(repoDir, ['branch', '-D', branchName]);
  }
  return {
    removed: res.status === 0,
    stderr: res.stderr || '',
  };
}
