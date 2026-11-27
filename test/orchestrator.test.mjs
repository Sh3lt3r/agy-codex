import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONFIG, listAvailableModels } from '../src/config.mjs';
import { formatCodexEventSummary } from '../src/codex-runner.mjs';
import { dispatchTask, resumeRun } from '../src/orchestrator.mjs';
import { runTaskQueue } from '../src/queue.mjs';
import { cleanupWorktree } from '../src/worktree.mjs';

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-codex-test-'));
  spawnSync('git', ['init'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, windowsHide: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# temp repo\n', 'utf8');
  spawnSync('git', ['add', '.'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, windowsHide: true });
  return dir;
}

test('auto-pushes back on evasive attempt 1 and succeeds on attempt 2 via session resume', async () => {
  const tmpDir = createTempRepo();
  try {
    const res = await dispatchTask({
      task: {
        id: 'evasion-recovery',
        title: 'Create feature module',
        cwd: tmpDir,
        objective: 'Create src/feature.mjs exporting ok = true',
        targetFiles: ['src/feature.mjs'],
        verifyCommands: ['node -e "import(\'./src/feature.mjs\').then(m => { if (!m.ok) process.exit(1); })"'],
      },
      config: DEFAULT_CONFIG,
      baseDir: tmpDir,
      mock: true,
      mockScenario: 'evasive-then-fixed',
    });

    assert.equal(res.summary.status, 'passed');
    assert.equal(res.summary.attempts.length, 2);
    assert.equal(res.summary.attempts[0].mode, 'exec');
    assert.equal(res.summary.attempts[0].evasion.severity, 'blocking');
    assert.equal(res.summary.attempts[1].mode, 'resume');
    assert.equal(res.summary.attempts[1].evasion.severity, 'none');
    assert.equal(res.summary.attempts[1].verifyPassed, true);
    assert.ok(fs.existsSync(res.reviewPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('escalates persistent evasion and supports manual commander resume', async () => {
  const tmpDir = createTempRepo();
  try {
    const res = await dispatchTask({
      task: {
        id: 'evasion-persistent',
        title: 'Implement validator',
        cwd: tmpDir,
        objective: 'Implement src/validator.mjs',
        targetFiles: ['src/validator.mjs'],
        maxAttempts: 2,
      },
      config: DEFAULT_CONFIG,
      baseDir: tmpDir,
      mock: true,
      mockScenario: 'evasive-persistent',
    });

    assert.equal(res.summary.status, 'evasion_escalated');
    assert.equal(res.summary.attempts.length, 2);

    const resumed = await resumeRun({
      runId: res.runId,
      note: 'Execute directly now without suggesting plans.',
      config: DEFAULT_CONFIG,
      baseDir: tmpDir,
      maxAdditionalAttempts: 1,
      mock: true,
      mockScenario: 'clean',
    });

    assert.equal(resumed.summary.status, 'passed');
    assert.equal(resumed.summary.attempts.length, 3);
    assert.equal(resumed.summary.attempts[2].mode, 'resume');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('retries automatically when verification command fails on attempt 1', async () => {
  const tmpDir = createTempRepo();
  try {
    const res = await dispatchTask({
      task: {
        id: 'verify-retry',
        title: 'Fix failing test',
        cwd: tmpDir,
        objective: 'Ensure src/check.mjs exports ok = true',
        targetFiles: ['src/check.mjs'],
        verifyCommands: ['node -e "import(\'./src/check.mjs\').then(m => { if (!m.ok) process.exit(1); })"'],
      },
      config: DEFAULT_CONFIG,
      baseDir: tmpDir,
      mock: true,
      mockScenario: 'test-fail',
    });

    assert.equal(res.summary.status, 'passed');
    assert.equal(res.summary.attempts.length, 2);
    assert.equal(res.summary.attempts[0].verifyPassed, false);
    assert.equal(res.summary.attempts[1].verifyPassed, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runs parallel queue with git worktree isolation', async () => {
  const tmpDir = createTempRepo();
  try {
    const out = await runTaskQueue({
      tasks: [
        {
          id: 'wt-a',
          title: 'Worktree task A',
          cwd: tmpDir,
          objective: 'Create a.mjs',
          targetFiles: ['a.mjs'],
        },
        {
          id: 'wt-b',
          title: 'Worktree task B',
          cwd: tmpDir,
          objective: 'Create b.mjs',
          targetFiles: ['b.mjs'],
        },
      ],
      config: DEFAULT_CONFIG,
      baseDir: tmpDir,
      concurrency: 2,
      useWorktree: true,
      mock: true,
      mockScenario: 'clean',
    });

    assert.equal(out.total, 2);
    assert.equal(out.passed, 2);
    assert.equal(out.failed, 0);

    for (const r of out.results) {
      assert.ok(r.summary.worktree?.worktreePath);
      assert.ok(fs.existsSync(r.summary.worktree.worktreePath));
      const clean = cleanupWorktree({
        repoDir: tmpDir,
        worktreePath: r.summary.worktree.worktreePath,
        branchName: r.summary.worktree.branchName,
        deleteBranch: true,
      });
      assert.equal(clean.removed, true);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('supports attaching an external sessionId and bypassSandbox option on dispatch', async () => {
  const tmpDir = createTempRepo();
  try {
    const res = await dispatchTask({
      task: {
        id: 'attach-ext',
        title: 'Attach external session',
        cwd: tmpDir,
        objective: 'Inspect workspace only',
        expectChanges: false,
      },
      config: DEFAULT_CONFIG,
      baseDir: tmpDir,
      bypassSandbox: true,
      sessionId: 'ext-session-1234',
      mock: true,
      mockScenario: 'clean',
    });

    assert.equal(res.summary.status, 'passed');
    assert.equal(res.summary.sessionId, 'ext-session-1234');
    assert.equal(res.summary.task.bypassSandbox, true);
    assert.equal(res.summary.attempts[0].mode, 'resume');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('supports explicit model selection and reads local model cache', async () => {
  const tmpDir = createTempRepo();
  const fakeCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-codex-home-'));
  try {
    fs.writeFileSync(path.join(fakeCodexHome, 'config.toml'), 'model = "gpt-6.2-sol"\n', 'utf8');
    fs.writeFileSync(
      path.join(fakeCodexHome, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list' },
          { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
        ],
      }),
      'utf8'
    );

    const listed = listAvailableModels({ codexHome: fakeCodexHome });
    assert.equal(listed.defaultModel, 'gpt-6.2-sol');
    assert.deepEqual(
      listed.models.map((m) => m.slug),
      ['gpt-6.2-sol']
    );

    const res = await dispatchTask({
      task: {
        id: 'model-override',
        title: 'Run with chosen model',
        cwd: tmpDir,
        objective: 'Inspect workspace',
        expectChanges: false,
      },
      config: DEFAULT_CONFIG,
      baseDir: tmpDir,
      model: 'gpt-6.2-sol',
      mock: true,
      mockScenario: 'clean',
    });

    assert.equal(res.summary.status, 'passed');
    assert.equal(res.summary.task.model, 'gpt-6.2-sol');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(fakeCodexHome, { recursive: true, force: true });
  }
});

test('formats concise single-line Codex progress summaries without raw dumps', () => {
  assert.equal(
    formatCodexEventSummary({ type: 'thread.started', thread_id: 'abc-123' }),
    'session=abc-123'
  );
  assert.equal(
    formatCodexEventSummary({
      type: 'item.started',
      item: { type: 'command_execution', command: 'npm test' },
    }),
    'cmd start: npm test'
  );
  assert.equal(
    formatCodexEventSummary({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'npm test', exit_code: 0 },
    }),
    'cmd done (exit=0): npm test'
  );
  assert.equal(
    formatCodexEventSummary({
      type: 'item.completed',
      item: { type: 'file_change', changes: [{ path: 'a.js' }, { path: 'b.js' }] },
    }),
    'file change (2 files)'
  );
  assert.equal(formatCodexEventSummary({ type: 'turn.started' }), null);
});
