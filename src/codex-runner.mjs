import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveCodexBinary } from './config.mjs';

function extractSessionIdFromEvents(jsonlText) {
  if (!jsonlText) return null;
  const lines = jsonlText.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const id =
        obj.thread_id ||
        obj.session_id ||
        obj.threadId ||
        obj.sessionId ||
        obj.thread?.id ||
        obj.session?.id;
      if (typeof id === 'string' && id.trim()) {
        return id.trim();
      }
    } catch {
      // Ignore non-JSON lines
    }
  }
  return null;
}

function extractLastMessageFromEvents(jsonlText) {
  if (!jsonlText) return '';
  const lines = jsonlText.split(/\r?\n/).filter(Boolean);
  let last = '';
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message' && obj.item?.text) {
        last = obj.item.text;
      } else if (typeof obj.message === 'string' && obj.role === 'assistant') {
        last = obj.message;
      } else if (typeof obj.text === 'string' && obj.type === 'assistant_message') {
        last = obj.text;
      }
    } catch {
      // Ignore non-JSON lines
    }
  }
  return last;
}

function quoteForCmd(arg) {
  if (/^[a-zA-Z0-9_./:\\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Built-in mock executor for offline testing and demos.
 */
async function runMockCodex({
  scenario = 'clean',
  attemptNumber = 1,
  cwd,
  sessionId,
  outputLastMessagePath,
  eventsPath,
  task,
}) {
  const resolvedSessionId = sessionId || `mock-session-${Date.now()}`;
  const targetFile = task?.mockTouchFile || (task?.targetFiles?.[0] ?? 'mock-output.txt');
  const fullTarget = path.resolve(cwd, targetFile);

  let message = '';
  let exitCode = 0;

  if (scenario === 'evasive-then-fixed' && attemptNumber === 1) {
    message = [
      `Before I proceed, could you clarify which coding style you prefer?`,
      `Here is how you can implement this manually:`,
      `1. Edit \`${targetFile}\` and add the required logic.`,
      `2. Please run the tests manually to verify.`,
      `Would you like me to go ahead and make these changes?`,
    ].join('\n');
  } else if (scenario === 'evasive-persistent') {
    message = `I have outlined a suggested plan for you. You can update ${targetFile} yourself, and let me know if you want me to implement the rest. This should work.`;
  } else if (scenario === 'test-fail' && attemptNumber === 1) {
    fs.mkdirSync(path.dirname(fullTarget), { recursive: true });
    fs.writeFileSync(fullTarget, `// broken draft\nexport const ok = false;\n`, 'utf8');
    message = [
      `Implemented initial draft in ${targetFile}.`,
      ``,
      `## EXECUTION_RECEIPT`,
      `STATUS: COMPLETED`,
      `CHANGED_FILES: ${targetFile}`,
      `VERIFICATION: skipped`,
      `DECISIONS: wrote draft`,
      `BLOCKER_EVIDENCE: NONE`,
    ].join('\n');
  } else {
    if (task?.expectChanges !== false) {
      fs.mkdirSync(path.dirname(fullTarget), { recursive: true });
      fs.writeFileSync(
        fullTarget,
        `// Completed by mock Codex (attempt ${attemptNumber})\nexport const ok = true;\n`,
        'utf8'
      );
    }
    message = [
      `Completed "${task?.title || 'task'}" directly in workspace.`,
      ``,
      `## EXECUTION_RECEIPT`,
      `STATUS: COMPLETED`,
      `CHANGED_FILES: ${task?.expectChanges !== false ? targetFile : 'NONE'}`,
      `VERIFICATION: all required checks passed`,
      `DECISIONS: applied workspace conventions`,
      `BLOCKER_EVIDENCE: NONE`,
    ].join('\n');
  }

  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: resolvedSessionId }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: message },
    }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, output_tokens: 80 } }),
  ].join('\n');

  if (eventsPath) fs.writeFileSync(eventsPath, events + '\n', 'utf8');
  if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, message, 'utf8');

  return {
    exitCode,
    timedOut: false,
    durationMs: 25,
    sessionId: resolvedSessionId,
    lastMessage: message,
    stdout: events,
    stderr: '',
    command: `mock-codex (${scenario}, attempt ${attemptNumber})`,
  };
}

/**
 * Execute `codex exec` or `codex exec resume <sessionId>`.
 */
export async function runCodex({
  prompt,
  cwd,
  config,
  sessionId = null,
  outputLastMessagePath,
  eventsPath,
  mock = false,
  mockScenario = 'clean',
  attemptNumber = 1,
  task = null,
  onOutput = null,
}) {
  if (mock) {
    return runMockCodex({
      scenario: mockScenario,
      attemptNumber,
      cwd,
      sessionId,
      outputLastMessagePath,
      eventsPath,
      task,
    });
  }

  const codexCfg = config.codex || {};
  const resolved = resolveCodexBinary(codexCfg.bin);
  if (!resolved.found) {
    throw new Error(
      `Codex CLI not found (checked PATH and common Windows locations). Install via "npm install -g @openai/codex" or set CODEX_BIN env / config.codex.bin.`
    );
  }

  const args = ['exec'];
  if (sessionId) {
    args.push('resume', sessionId);
  }

  args.push('--json');

  if (outputLastMessagePath) {
    args.push('--output-last-message', outputLastMessagePath);
  }

  if (!sessionId && cwd) {
    args.push('-C', cwd);
  }

  const selectedModel = task?.model || codexCfg.model;
  if (selectedModel) {
    args.push('-m', selectedModel);
  }

  const bypassSandbox = Boolean(task?.bypassSandbox || codexCfg.bypassSandbox);
  const skipGitRepoCheck = Boolean(task?.skipGitRepoCheck || codexCfg.skipGitRepoCheck);

  if (bypassSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (codexCfg.fullAuto) {
    args.push('--full-auto');
  } else {
    if (codexCfg.sandbox && !sessionId) {
      args.push('--sandbox', codexCfg.sandbox);
    }
    if (codexCfg.approvalPolicy && !sessionId) {
      args.push('-c', `approval_policy="${codexCfg.approvalPolicy}"`);
    }
  }

  if (skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }

  if (Array.isArray(codexCfg.extraArgs) && codexCfg.extraArgs.length > 0) {
    args.push(...codexCfg.extraArgs);
  }

  const useStdin = (codexCfg.promptDelivery || 'stdin') === 'stdin';
  if (useStdin) {
    args.push('-');
  } else {
    args.push(prompt);
  }

  const isWin = process.platform === 'win32';
  const isBatch = isWin && /\.(cmd|bat)$/i.test(resolved.path);
  const spawnCmd = isBatch ? 'cmd.exe' : resolved.path;
  const spawnArgs = isBatch
    ? ['/d', '/s', '/c', `${quoteForCmd(resolved.path)} ${args.map(quoteForCmd).join(' ')}`]
    : args;

  const startTime = Date.now();
  const timeoutMs = codexCfg.timeoutMs || 600000;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (onOutput) onOutput('stdout', text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (onOutput) onOutput('stderr', text);
    });

    if (useStdin) {
      child.stdin.write(prompt, 'utf8');
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (eventsPath) {
        fs.writeFileSync(eventsPath, stdout, 'utf8');
      }

      let lastMessage = '';
      if (outputLastMessagePath && fs.existsSync(outputLastMessagePath)) {
        lastMessage = fs.readFileSync(outputLastMessagePath, 'utf8');
      }
      if (!lastMessage) {
        lastMessage = extractLastMessageFromEvents(stdout) || stdout.trim();
        if (outputLastMessagePath && lastMessage) {
          fs.writeFileSync(outputLastMessagePath, lastMessage, 'utf8');
        }
      }

      const detectedSessionId = extractSessionIdFromEvents(stdout) || sessionId;

      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        timedOut,
        durationMs,
        sessionId: detectedSessionId,
        lastMessage,
        stdout,
        stderr,
        command: `${resolved.path} ${args.join(' ')}`,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        timedOut: false,
        durationMs: Date.now() - startTime,
        sessionId,
        lastMessage: '',
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        command: `${resolved.path} ${args.join(' ')}`,
      });
    });
  });
}
