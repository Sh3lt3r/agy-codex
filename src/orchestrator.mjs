import fs from 'node:fs';
import path from 'node:path';
import { buildInitialDirective, buildPushbackDirective } from './prompt-builder.mjs';
import { analyzeEvasion } from './evasion-detector.mjs';
import { runCodex } from './codex-runner.mjs';
import { captureBaseline, verifyWorkspace } from './verifier.mjs';
import { createWorktree } from './worktree.mjs';
import {
  createRunDir,
  generateRunId,
  getAttemptDir,
  getRunsRoot,
  loadRunSummary,
  renderReviewMarkdown,
  writeJson,
} from './store.mjs';

export function normalizeTask(rawTask, fallbackCwd) {
  const id = rawTask.id || `task-${Date.now()}`;
  const title = rawTask.title || id;
  return {
    id,
    title,
    objective: rawTask.objective || rawTask.prompt || '',
    cwd: path.resolve(rawTask.cwd || fallbackCwd || process.cwd()),
    targetFiles: Array.isArray(rawTask.targetFiles) ? rawTask.targetFiles : [],
    constraints: Array.isArray(rawTask.constraints) ? rawTask.constraints : [],
    acceptanceCriteria: Array.isArray(rawTask.acceptanceCriteria) ? rawTask.acceptanceCriteria : [],
    verifyCommands: Array.isArray(rawTask.verifyCommands) ? rawTask.verifyCommands : [],
    expectChanges: rawTask.expectChanges !== false,
    maxAttempts: rawTask.maxAttempts || null,
    useWorktree: Boolean(rawTask.useWorktree),
    baseRef: rawTask.baseRef || 'HEAD',
    model: rawTask.model || '',
    bypassSandbox: Boolean(rawTask.bypassSandbox),
    skipGitRepoCheck: Boolean(rawTask.skipGitRepoCheck),
    sessionId: rawTask.sessionId || null,
    mockTouchFile: rawTask.mockTouchFile || null,
  };
}

export async function dispatchTask({
  task: rawTask,
  config,
  baseDir = process.cwd(),
  mock = false,
  mockScenario = 'clean',
  useWorktree = false,
  model = '',
  bypassSandbox = false,
  sessionId = null,
  onEvent = null,
}) {
  const task = normalizeTask(rawTask, baseDir);
  if (model) task.model = model;
  if (bypassSandbox) task.bypassSandbox = true;
  if (sessionId) task.sessionId = sessionId;
  const runsRoot = getRunsRoot(baseDir, config);
  const runId = generateRunId(task.id);
  const runDir = createRunDir(runsRoot, runId);
  const maxAttempts = task.maxAttempts || config.orchestrator?.maxAttempts || 3;

  let executionCwd = task.cwd;
  let worktreeInfo = null;
  if (useWorktree || task.useWorktree) {
    worktreeInfo = createWorktree({
      repoDir: task.cwd,
      worktreesDir: config.orchestrator?.worktreesDir || '.worktrees',
      runId,
      baseRef: task.baseRef || 'HEAD',
    });
    executionCwd = worktreeInfo.worktreePath;
  }

  writeJson(path.join(runDir, 'task.json'), task);

  const startedAt = new Date().toISOString();
  const baseline = captureBaseline(executionCwd);

  const summary = {
    runId,
    task,
    status: 'running',
    sessionId: task.sessionId || null,
    executionCwd,
    worktree: worktreeInfo,
    maxAttempts,
    startedAt,
    finishedAt: null,
    attempts: [],
  };

  writeJson(path.join(runDir, 'summary.json'), summary);

  return executeAttemptLoop({
    summary,
    runDir,
    config,
    baseline,
    startAttempt: 1,
    initialPrompt: buildInitialDirective(task),
    mock,
    mockScenario,
    onEvent,
  });
}

export async function resumeRun({
  runId,
  note = '',
  config,
  baseDir = process.cwd(),
  maxAdditionalAttempts = 1,
  model = '',
  bypassSandbox = false,
  mock = false,
  mockScenario = 'clean',
  onEvent = null,
}) {
  const runsRoot = getRunsRoot(baseDir, config);
  const { runDir, summary } = loadRunSummary(runsRoot, runId);
  if (model) summary.task.model = model;
  if (bypassSandbox) summary.task.bypassSandbox = true;
  const lastAttempt = summary.attempts[summary.attempts.length - 1];
  const nextAttempt = summary.attempts.length + 1;
  summary.maxAttempts = Math.max(summary.maxAttempts, summary.attempts.length + maxAdditionalAttempts);
  summary.status = 'running';

  const baseline = captureBaseline(summary.executionCwd);
  const prompt = buildPushbackDirective({
    task: summary.task,
    attemptNumber: nextAttempt,
    evasionReport: lastAttempt?.evasion || null,
    verification: lastAttempt?.verificationSummary || null,
    customNote: note || 'Continue and complete all remaining acceptance criteria without evasion.',
  });

  return executeAttemptLoop({
    summary,
    runDir,
    config,
    baseline,
    startAttempt: nextAttempt,
    initialPrompt: prompt,
    mock,
    mockScenario,
    onEvent,
  });
}

async function executeAttemptLoop({
  summary,
  runDir,
  config,
  baseline,
  startAttempt,
  initialPrompt,
  mock,
  mockScenario,
  onEvent,
}) {
  let prompt = initialPrompt;
  let latestDiffStat = '';
  let latestMessage = '';

  const autoResumeOnEvasion = config.orchestrator?.autoResumeOnEvasion !== false;
  const autoResumeOnVerifyFail = config.orchestrator?.autoResumeOnVerifyFail !== false;
  const strictAntiEvasion = config.orchestrator?.strictAntiEvasion !== false;

  for (let attemptNumber = startAttempt; attemptNumber <= summary.maxAttempts; attemptNumber++) {
    const attemptDir = getAttemptDir(runDir, attemptNumber);
    const mode = summary.sessionId ? 'resume' : 'exec';
    const promptPath = path.join(attemptDir, 'prompt.md');
    const lastMessagePath = path.join(attemptDir, 'last-message.md');
    const eventsPath = path.join(attemptDir, 'events.jsonl');

    fs.writeFileSync(promptPath, prompt, 'utf8');
    if (onEvent) {
      onEvent({ type: 'attempt_start', runId: summary.runId, attemptNumber, mode });
    }

    const codexResult = await runCodex({
      prompt,
      cwd: summary.executionCwd,
      config,
      sessionId: summary.sessionId,
      outputLastMessagePath: lastMessagePath,
      eventsPath,
      mock,
      mockScenario,
      attemptNumber,
      task: summary.task,
      onProgress: onEvent
        ? ({ summary: progressSummary }) => {
            onEvent({
              type: 'codex_progress',
              runId: summary.runId,
              attemptNumber,
              summary: progressSummary,
            });
          }
        : null,
    });

    if (codexResult.sessionId) {
      summary.sessionId = codexResult.sessionId;
    }
    latestMessage = codexResult.lastMessage || '';

    const verification = verifyWorkspace({
      cwd: summary.executionCwd,
      task: summary.task,
      baseline,
    });
    latestDiffStat = verification.diffStat;

    const evasion = analyzeEvasion({
      task: summary.task,
      responseText: latestMessage,
      verification,
      exitCode: codexResult.exitCode,
      config,
    });

    if (verification.diffText) {
      fs.writeFileSync(path.join(attemptDir, 'diff.patch'), verification.diffText, 'utf8');
      fs.writeFileSync(path.join(runDir, 'diff.patch'), verification.diffText, 'utf8');
    }
    writeJson(path.join(attemptDir, 'evasion.json'), evasion);
    writeJson(path.join(attemptDir, 'verify.json'), {
      ...verification,
      diffText: undefined,
    });

    const attemptRecord = {
      attemptNumber,
      mode,
      command: codexResult.command,
      exitCode: codexResult.exitCode,
      timedOut: codexResult.timedOut,
      durationMs: codexResult.durationMs,
      changedFiles: verification.changedFiles,
      verifyPassed: verification.allPassed,
      verificationSummary: {
        allPassed: verification.allPassed,
        checks: verification.checks,
      },
      evasion,
    };

    summary.attempts.push(attemptRecord);
    if (onEvent) {
      onEvent({
        type: 'attempt_done',
        runId: summary.runId,
        attemptNumber,
        evasionSeverity: evasion.severity,
        verifyPassed: verification.allPassed,
        changedFiles: verification.changedFiles.length,
      });
    }

    const evasionFailed =
      evasion.severity === 'blocking' || (strictAntiEvasion && evasion.severity === 'warning');
    const verifyFailed = !verification.allPassed;
    const processFailed = codexResult.exitCode !== 0;

    if (!evasionFailed && !verifyFailed && !processFailed) {
      summary.status = 'passed';
      break;
    }

    if (evasion.hardBlockerDeclared && !verifyFailed && evasion.severity !== 'blocking') {
      summary.status = 'blocked';
      break;
    }

    const canRetry = attemptNumber < summary.maxAttempts;
    const shouldRetry =
      canRetry &&
      ((evasionFailed && autoResumeOnEvasion) ||
        ((verifyFailed || processFailed) && autoResumeOnVerifyFail));

    if (!shouldRetry) {
      if (evasionFailed) {
        summary.status = 'evasion_escalated';
      } else if (verifyFailed) {
        summary.status = 'verification_failed';
      } else {
        summary.status = 'failed';
      }
      break;
    }

    prompt = buildPushbackDirective({
      task: summary.task,
      attemptNumber: attemptNumber + 1,
      evasionReport: evasion,
      verification,
    });
  }

  summary.finishedAt = new Date().toISOString();
  writeJson(path.join(runDir, 'summary.json'), summary);

  const reviewMd = renderReviewMarkdown(summary, latestDiffStat, latestMessage);
  fs.writeFileSync(path.join(runDir, 'review.md'), reviewMd, 'utf8');

  return {
    runId: summary.runId,
    runDir,
    reviewPath: path.join(runDir, 'review.md'),
    summary,
  };
}
