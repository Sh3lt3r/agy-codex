import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function generateRunId(taskId = 'task') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = String(taskId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28) || 'task';
  const rand = crypto.randomBytes(2).toString('hex');
  return `${ts}_${slug}_${rand}`;
}

export function getRunsRoot(baseDir, config) {
  return path.resolve(baseDir, config.orchestrator?.runsDir || 'runs');
}

export function createRunDir(runsRoot, runId) {
  const dir = path.join(runsRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAttemptDir(runDir, attemptNumber) {
  const dir = path.join(runDir, `attempt-${attemptNumber}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function loadRunSummary(runsRoot, runId) {
  const runDir = path.join(runsRoot, runId);
  const summaryPath = path.join(runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Run not found: ${runId} (expected ${summaryPath})`);
  }
  return { runDir, summary: readJson(summaryPath) };
}

export function listRuns(runsRoot) {
  if (!fs.existsSync(runsRoot)) return [];
  const entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const summaryPath = path.join(runsRoot, entry.name, 'summary.json');
    if (!fs.existsSync(summaryPath)) continue;
    try {
      runs.push(readJson(summaryPath));
    } catch {
      // skip malformed
    }
  }
  return runs.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

export function renderReviewMarkdown(summary, latestDiffStat = '', latestMessage = '') {
  const lines = [
    `# Commander Review Report: ${summary.task.title}`,
    ``,
    `- **Run ID**: \`${summary.runId}\``,
    `- **Task ID**: \`${summary.task.id}\``,
    `- **Status**: \`${summary.status}\``,
    `- **Codex Session ID**: \`${summary.sessionId || 'N/A'}\``,
    `- **Workspace**: \`${summary.executionCwd}\``,
    summary.worktree ? `- **Worktree Branch**: \`${summary.worktree.branchName}\`` : null,
    `- **Attempts**: ${summary.attempts.length} / ${summary.maxAttempts}`,
    `- **Started**: ${summary.startedAt}`,
    `- **Finished**: ${summary.finishedAt}`,
    ``,
    `## Attempt History & Anti-Evasion Audit`,
    ``,
  ].filter((l) => l !== null);

  for (const att of summary.attempts) {
    lines.push(`### Attempt ${att.attemptNumber} (${att.mode})`);
    lines.push(`- Exit code: \`${att.exitCode}\` | Duration: ${att.durationMs}ms`);
    lines.push(
      `- Anti-Evasion: **${att.evasion.severity.toUpperCase()}** (score=${att.evasion.score}, categories=${att.evasion.categories.join(', ') || 'none'})`
    );
    lines.push(
      `- Changed Files (${att.changedFiles.length}): ${att.changedFiles.length ? att.changedFiles.map((f) => `\`${f}\``).join(', ') : 'NONE'}`
    );
    lines.push(`- Verification Passed: \`${att.verifyPassed}\``);
    if (att.evasion.findings.length > 0) {
      lines.push(`- Evasion Findings:`);
      for (const f of att.evasion.findings) {
        lines.push(`  - **[${f.category}]** ${f.summary}`);
      }
    }
    lines.push('');
  }

  if (latestDiffStat) {
    lines.push(`## Git Diff Summary`);
    lines.push('```text');
    lines.push(latestDiffStat);
    lines.push('```');
    lines.push('');
  }

  lines.push(`## Latest Codex Response`);
  lines.push('```markdown');
  lines.push((latestMessage || '').trim() || '(empty)');
  lines.push('```');
  lines.push('');

  lines.push(`## Commander Next Actions`);
  if (summary.status === 'passed') {
    lines.push(`- Review \`diff.patch\` and accept/merge changes.`);
  } else {
    lines.push(
      `- Push back or resume this session:\n  \`node bin/agy-codex.mjs resume --run ${summary.runId} --note "<your corrective directive>"\``
    );
  }

  return lines.join('\n');
}
