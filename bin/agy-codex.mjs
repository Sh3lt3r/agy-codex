#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { listAvailableModels, loadConfig, resolveCodexBinary } from '../src/config.mjs';
import { dispatchTask, resumeRun } from '../src/orchestrator.mjs';
import { runTaskQueue } from '../src/queue.mjs';
import { getRunsRoot, listRuns, loadRunSummary } from '../src/store.mjs';
import { cleanupWorktree } from '../src/worktree.mjs';

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        if (flags[key] !== undefined) {
          flags[key] = Array.isArray(flags[key]) ? [...flags[key], next] : [flags[key], next];
        } else {
          flags[key] = next;
        }
        i++;
      }
    } else {
      positionals.push(token);
    }
  }
  return { command: positionals[0] || 'help', positionals: positionals.slice(1), flags };
}

function asArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function printHelp() {
  console.log(`agy-codex — Antigravity-to-Codex Command & Anti-Evasion Orchestrator

Usage:
  agy-codex doctor [--config <path>]
  agy-codex models [--all] [--json]
  agy-codex init-task --out <file> [--id <id>] [--title <title>]
  agy-codex dispatch --task <task.json> [--model <slug>] [--select-model] [--worktree] [--bypass-sandbox] [--session <id>] [--mock] [--mock-scenario <name>]
  agy-codex dispatch --title <t> --objective <o> [--cwd <dir>] [--model <slug>] [--select-model] [--verify <cmd>] [--target <file>] [--worktree] [--bypass-sandbox] [--session <id>] [--mock]
  agy-codex resume --run <run-id> [--note <directive>] [--model <slug>] [--select-model] [--attempts <n>] [--bypass-sandbox] [--mock]
  agy-codex queue --file <queue.json> [--model <slug>] [--concurrency <n>] [--worktree] [--mock]
  agy-codex review --run <run-id> [--json]
  agy-codex status [--json]
  agy-codex cleanup-worktree --run <run-id> [--delete-branch]
`);
}

function cmdDoctor(config, configPath) {
  const codex = resolveCodexBinary(config.codex?.bin);
  const gitRes = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  let codexVersion = null;
  if (codex.found) {
    const isWin = process.platform === 'win32';
    const isBatch = isWin && /\.(cmd|bat)$/i.test(codex.path);
    const vRes = spawnSync(
      isBatch ? 'cmd.exe' : codex.path,
      isBatch ? ['/d', '/s', '/c', `"${codex.path}" --version`] : ['--version'],
      { encoding: 'utf8', windowsHide: true }
    );
    if (vRes.status === 0) codexVersion = (vRes.stdout || vRes.stderr).trim();
  }

  const report = {
    node: process.version,
    platform: process.platform,
    configPath: configPath || '(defaults)',
    git: gitRes.status === 0 ? gitRes.stdout.trim() : 'not-found',
    codex: {
      found: codex.found,
      path: codex.path,
      source: codex.source,
      version: codexVersion,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (!codex.found) {
    console.error(
      '\n[Hint] Codex CLI not detected. Install via `npm install -g @openai/codex` or set CODEX_BIN / config.codex.bin.'
    );
    console.error('       You can still test the full orchestration & anti-evasion pipeline with `--mock`.');
  }
}

function cmdModels(flags, config) {
  const info = listAvailableModels({ includeHidden: Boolean(flags.all) });
  const effectiveDefault = config.codex?.model || info.defaultModel || '';
  if (flags.json) {
    console.log(JSON.stringify({ ...info, effectiveDefault }, null, 2));
    return;
  }
  console.log(`Default model: ${effectiveDefault || '(codex CLI default)'}`);
  if (info.models.length === 0) {
    console.log('No cached Codex models found. Pass --model <slug> manually if needed.');
    return;
  }
  console.log('\nAvailable Codex models:');
  info.models.forEach((m, idx) => {
    const marker = m.slug === effectiveDefault ? ' (default)' : '';
    console.log(`  ${idx + 1}. ${m.slug} — ${m.displayName}${marker}`);
  });
}

async function maybeSelectModelInteractively({ explicitModel, selectFlag, config }) {
  if (explicitModel) return explicitModel;
  const shouldPrompt = Boolean(selectFlag || config.codex?.promptModelSelection);
  if (!shouldPrompt || !process.stdin.isTTY || !process.stdout.isTTY) {
    return '';
  }

  const info = listAvailableModels();
  if (info.models.length === 0) return '';

  const effectiveDefault = config.codex?.model || info.defaultModel || '';
  console.log('\nSelect Codex model for this conversation:');
  info.models.forEach((m, idx) => {
    const marker = m.slug === effectiveDefault ? ' [default]' : '';
    console.log(`  ${idx + 1}. ${m.slug} (${m.displayName})${marker}`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(`Enter number or model slug [Enter for ${effectiveDefault || 'default'}]: `)
    ).trim();
    if (!answer) return effectiveDefault;
    const asNum = Number(answer);
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= info.models.length) {
      return info.models[asNum - 1].slug;
    }
    return answer;
  } finally {
    rl.close();
  }
}

function cmdInitTask(flags) {
  const out = path.resolve(flags.out || path.join('tasks', `${flags.id || 'task-001'}.json`));
  const template = {
    id: flags.id || 'task-001',
    title: flags.title || 'Implement feature and verify with tests',
    cwd: flags.cwd || '.',
    objective: 'Describe the exact implementation goal here.',
    targetFiles: ['src/example.mjs'],
    constraints: ['Keep edits focused and minimal', 'Do not introduce TODO placeholders'],
    acceptanceCriteria: ['Feature works end-to-end', 'All verification commands exit with code 0'],
    verifyCommands: ['npm test'],
    expectChanges: true,
    useWorktree: false,
    maxAttempts: 3,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(template, null, 2) + '\n', 'utf8');
  console.log(`Created task file: ${out}`);
}

async function cmdDispatch(flags, config) {
  let task;
  if (flags.task) {
    const taskPath = path.resolve(flags.task);
    task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    if (flags.cwd) task.cwd = path.resolve(flags.cwd);
  } else if (flags.objective || flags.prompt) {
    task = {
      id: flags.id || `task-${Date.now()}`,
      title: flags.title || 'Ad-hoc Codex Task',
      cwd: path.resolve(flags.cwd || process.cwd()),
      objective: flags.objective || flags.prompt,
      targetFiles: asArray(flags.target),
      constraints: asArray(flags.constraint),
      acceptanceCriteria: asArray(flags.accept),
      verifyCommands: asArray(flags.verify),
      expectChanges: flags['no-changes'] ? false : true,
      maxAttempts: flags.attempts ? Number(flags.attempts) : undefined,
    };
  } else {
    throw new Error('Provide either --task <file.json> or --objective "<text>".');
  }

  const selectedModel = await maybeSelectModelInteractively({
    explicitModel: typeof flags.model === 'string' ? flags.model : task.model || '',
    selectFlag: Boolean(flags['select-model']),
    config,
  });

  const res = await dispatchTask({
    task,
    config,
    baseDir: process.cwd(),
    useWorktree: Boolean(flags.worktree),
    model: selectedModel,
    bypassSandbox: Boolean(flags['bypass-sandbox']),
    sessionId: typeof flags.session === 'string' ? flags.session : null,
    mock: Boolean(flags.mock),
    mockScenario: typeof flags['mock-scenario'] === 'string' ? flags['mock-scenario'] : 'clean',
    onEvent: (ev) => {
      if (flags.json) return;
      if (ev.type === 'attempt_start') {
        console.log(`[${ev.runId}] Attempt ${ev.attemptNumber} (${ev.mode}) started...`);
      } else if (ev.type === 'codex_progress') {
        const ts = new Date().toTimeString().slice(0, 8);
        console.log(`[${ev.runId}] [${ts}] ${ev.summary}`);
      } else if (ev.type === 'attempt_done') {
        console.log(
          `[${ev.runId}] Attempt ${ev.attemptNumber} done | evasion=${ev.evasionSeverity} | verifyPassed=${ev.verifyPassed} | changedFiles=${ev.changedFiles}`
        );
      }
    },
  });

  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`\nRun ID:      ${res.runId}`);
    console.log(`Status:      ${res.summary.status}`);
    console.log(`Session ID:  ${res.summary.sessionId || 'N/A'}`);
    console.log(`Attempts:    ${res.summary.attempts.length}/${res.summary.maxAttempts}`);
    console.log(`Review File: ${res.reviewPath}`);
  }

  if (res.summary.status !== 'passed') {
    process.exitCode = 2;
  }
}

async function cmdResume(flags, config) {
  if (!flags.run) throw new Error('Missing --run <run-id>.');
  const selectedModel = await maybeSelectModelInteractively({
    explicitModel: typeof flags.model === 'string' ? flags.model : '',
    selectFlag: Boolean(flags['select-model']),
    config,
  });
  const res = await resumeRun({
    runId: flags.run,
    note: typeof flags.note === 'string' ? flags.note : '',
    config,
    baseDir: process.cwd(),
    maxAdditionalAttempts: flags.attempts ? Number(flags.attempts) : 1,
    model: selectedModel,
    bypassSandbox: Boolean(flags['bypass-sandbox']),
    mock: Boolean(flags.mock),
    mockScenario: typeof flags['mock-scenario'] === 'string' ? flags['mock-scenario'] : 'clean',
    onEvent: (ev) => {
      if (flags.json) return;
      if (ev.type === 'attempt_start') {
        console.log(`[${ev.runId}] Attempt ${ev.attemptNumber} (${ev.mode}) started...`);
      } else if (ev.type === 'codex_progress') {
        const ts = new Date().toTimeString().slice(0, 8);
        console.log(`[${ev.runId}] [${ts}] ${ev.summary}`);
      } else if (ev.type === 'attempt_done') {
        console.log(
          `[${ev.runId}] Attempt ${ev.attemptNumber} done | evasion=${ev.evasionSeverity} | verifyPassed=${ev.verifyPassed} | changedFiles=${ev.changedFiles}`
        );
      }
    },
  });

  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`Resumed Run: ${res.runId}`);
    console.log(`Status:      ${res.summary.status}`);
    console.log(`Attempts:    ${res.summary.attempts.length}`);
    console.log(`Review File: ${res.reviewPath}`);
  }
  if (res.summary.status !== 'passed') process.exitCode = 2;
}

async function cmdQueue(flags, config) {
  if (!flags.file) throw new Error('Missing --file <queue.json>.');
  const raw = JSON.parse(fs.readFileSync(path.resolve(flags.file), 'utf8'));
  const tasks = (Array.isArray(raw) ? raw : raw.tasks).map((t) =>
    typeof flags.model === 'string' && !t.model ? { ...t, model: flags.model } : t
  );

  const out = await runTaskQueue({
    tasks,
    config,
    baseDir: process.cwd(),
    concurrency: flags.concurrency ? Number(flags.concurrency) : raw.concurrency,
    useWorktree: Boolean(flags.worktree || raw.useWorktree),
    mock: Boolean(flags.mock),
    mockScenario: typeof flags['mock-scenario'] === 'string' ? flags['mock-scenario'] : 'clean',
    onEvent: (ev) => {
      if (flags.json) return;
      if (ev.type === 'queue_start') {
        console.log(`[worker-${ev.workerIndex}] Starting task ${ev.taskId}...`);
      } else if (ev.type === 'queue_done') {
        console.log(`[worker-${ev.workerIndex}] Finished task ${ev.taskId} -> ${ev.status}`);
      }
    },
  });

  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`\nQueue Complete: ${out.passed}/${out.total} passed (${out.failed} failed)`);
    for (const r of out.results) {
      console.log(`- ${r.summary?.task?.id || r.taskId}: ${r.summary?.status || r.error} (${r.runId || 'no-run'})`);
    }
  }
  if (out.failed > 0) process.exitCode = 2;
}

function cmdReview(flags, config) {
  if (!flags.run) throw new Error('Missing --run <run-id>.');
  const runsRoot = getRunsRoot(process.cwd(), config);
  const { runDir, summary } = loadRunSummary(runsRoot, flags.run);
  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const reviewPath = path.join(runDir, 'review.md');
    console.log(fs.readFileSync(reviewPath, 'utf8'));
  }
}

function cmdStatus(flags, config) {
  const runsRoot = getRunsRoot(process.cwd(), config);
  const runs = listRuns(runsRoot);
  if (flags.json) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  if (runs.length === 0) {
    console.log('No runs recorded yet.');
    return;
  }
  for (const r of runs) {
    const lastAtt = r.attempts[r.attempts.length - 1];
    console.log(
      `${r.runId} | ${r.status.padEnd(19)} | attempts=${r.attempts.length}/${r.maxAttempts} | evasion=${lastAtt?.evasion?.severity || 'n/a'} | session=${r.sessionId || 'n/a'} | ${r.task.title}`
    );
  }
}

function cmdCleanupWorktree(flags, config) {
  if (!flags.run) throw new Error('Missing --run <run-id>.');
  const runsRoot = getRunsRoot(process.cwd(), config);
  const { summary } = loadRunSummary(runsRoot, flags.run);
  if (!summary.worktree) {
    console.log(`Run ${flags.run} did not use a worktree.`);
    return;
  }
  const res = cleanupWorktree({
    repoDir: summary.worktree.repoDir,
    worktreePath: summary.worktree.worktreePath,
    branchName: summary.worktree.branchName,
    deleteBranch: Boolean(flags['delete-branch']),
  });
  console.log(JSON.stringify(res, null, 2));
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'help' || flags.help) {
    printHelp();
    return;
  }

  const { config, configPath } = loadConfig(flags.config);

  switch (command) {
    case 'doctor':
      cmdDoctor(config, configPath);
      break;
    case 'models':
      cmdModels(flags, config);
      break;
    case 'init-task':
      cmdInitTask(flags);
      break;
    case 'dispatch':
      await cmdDispatch(flags, config);
      break;
    case 'resume':
      await cmdResume(flags, config);
      break;
    case 'queue':
      await cmdQueue(flags, config);
      break;
    case 'review':
      cmdReview(flags, config);
      break;
    case 'status':
      cmdStatus(flags, config);
      break;
    case 'cleanup-worktree':
      cmdCleanupWorktree(flags, config);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[agy-codex error] ${err.message}`);
  process.exitCode = 1;
});
