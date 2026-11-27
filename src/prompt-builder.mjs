/**
 * Prompt Builder & Escalating Anti-Evasion Pushback Compiler
 *
 * Compiles structured Antigravity task specs into high-compliance Codex directives
 * and builds escalating corrective prompts when Codex evades or fails verification.
 */

function formatList(items, fallback = 'None') {
  if (!Array.isArray(items) || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join('\n');
}

export function buildInitialDirective(task) {
  const expectChanges = task.expectChanges !== false;
  const sections = [
    `# COMMANDER DIRECTIVE (Antigravity -> Codex)`,
    ``,
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Working Mode: Autonomous execution (non-interactive).`,
    ``,
    `## Objective`,
    task.objective || task.prompt || '',
    ``,
    `## Scope & Target Files`,
    formatList(task.targetFiles, 'Determine exact files inside the workspace as needed.'),
    ``,
    `## Constraints`,
    formatList(task.constraints, 'Follow existing repository conventions and keep edits focused.'),
    ``,
    `## Acceptance Criteria`,
    formatList(task.acceptanceCriteria, 'All requirements implemented cleanly and verified.'),
    ``,
    `## Required Verification Commands`,
    formatList(task.verifyCommands, 'Run relevant build/test/lint checks available in this repository.'),
    ``,
    `## MANDATORY EXECUTION PROTOCOL (NON-NEGOTIABLE)`,
    `1. ACT DIRECTLY: You are running in a non-interactive orchestrated pipeline. Do NOT ask clarifying questions, do NOT ask for permission to proceed, and do NOT output a plan or tutorial instead of editing files.`,
    `2. RESOLVE AMBIGUITY AUTONOMOUSLY: If a minor detail is unspecified, choose the cleanest, most standard option consistent with the codebase, implement it completely, and document your choice in the receipt.`,
    expectChanges
      ? `3. COMPLETE IMPLEMENTATION: Actually modify/create the required files in the workspace. Do NOT leave TODO/FIXME stubs, omitted snippets ("for brevity"), or partial work.`
      : `3. THOROUGH ANALYSIS: Inspect the real repository files and provide concrete, file-backed findings.`,
    `4. VERIFY BEFORE REPORTING: Run the required verification commands yourself and report real command exit codes and output. Never say "this should work" without running checks.`,
    `5. GENUINE BLOCKERS ONLY: Only report STATUS: BLOCKED if a hard external constraint makes execution impossible after attempting reasonable alternatives, and include exact command/error evidence under BLOCKER_EVIDENCE:.`,
    ``,
    `## REQUIRED FINAL OUTPUT FORMAT`,
    `End your final response with this exact structured block:`,
    ``,
    `## EXECUTION_RECEIPT`,
    `STATUS: COMPLETED | BLOCKED`,
    `CHANGED_FILES: <comma-separated relative paths, or NONE>`,
    `VERIFICATION: <commands run and pass/fail results>`,
    `DECISIONS: <key autonomous decisions made, or NONE>`,
    `BLOCKER_EVIDENCE: <exact error output if BLOCKED, otherwise NONE>`,
  ];

  return sections.join('\n');
}

export function buildPushbackDirective({
  task,
  attemptNumber,
  evasionReport,
  verification,
  customNote = '',
}) {
  const level = attemptNumber <= 2 ? 'FIRM_CORRECTION' : 'FINAL_ZERO_TOLERANCE';
  const lines = [
    `# COMMANDER PUSHBACK DIRECTIVE [${level} - Attempt ${attemptNumber}]`,
    ``,
    `Your previous response for task "${task.title}" (${task.id}) was REJECTED by the Antigravity orchestrator.`,
    ``,
  ];

  if (evasionReport?.detected) {
    lines.push(`## Anti-Evasion Audit Violations (Score: ${evasionReport.score}, Severity: ${evasionReport.severity})`);
    for (const finding of evasionReport.findings) {
      lines.push(`- [${finding.category}] ${finding.summary}`);
      if (finding.evidence?.length) {
        lines.push(`  Evidence: ${finding.evidence.join(' | ')}`);
      }
    }
    lines.push('');
  }

  if (verification && !verification.allPassed) {
    lines.push(`## Failed Verification Commands`);
    for (const check of verification.checks.filter((c) => !c.passed)) {
      lines.push(`- Command: \`${check.command}\` (exit code ${check.exitCode})`);
      const snippet = (check.stderr || check.stdout || '').trim().slice(0, 800);
      if (snippet) {
        lines.push('```text');
        lines.push(snippet);
        lines.push('```');
      }
    }
    lines.push('');
  }

  if (customNote) {
    lines.push(`## Additional Commander Instructions`);
    lines.push(customNote);
    lines.push('');
  }

  lines.push(`## MANDATORY CORRECTIVE ACTIONS`);
  if (evasionReport?.categories.includes('clarification_deflection')) {
    lines.push(`- STOP asking questions or requesting confirmation. Make the best engineering decision and execute it NOW.`);
  }
  if (
    evasionReport?.categories.includes('advice_only_deflection') ||
    evasionReport?.categories.includes('zero_diff_claim')
  ) {
    lines.push(`- STOP describing what the user should do. Directly edit the workspace files NOW so \`git status\` / \`git diff\` reflects the completed implementation.`);
  }
  if (
    evasionReport?.categories.includes('deferred_work') ||
    evasionReport?.categories.includes('diff_placeholders')
  ) {
    lines.push(`- REMOVE all TODOs, stubs, and omitted sections. Finish 100% of the implementation.`);
  }
  if (evasionReport?.categories.includes('unverified_claim') || (verification && !verification.allPassed)) {
    lines.push(`- FIX all failing checks and run every required verification command until exit code is 0.`);
  }
  if (evasionReport?.categories.includes('premature_surrender')) {
    lines.push(`- DO NOT surrender or ask the user to run commands manually. Execute within this workspace, or if truly impossible, provide exact command + stderr proof under BLOCKER_EVIDENCE.`);
  }
  if (level === 'FINAL_ZERO_TOLERANCE') {
    lines.push(`- THIS IS THE FINAL AUTOMATED ATTEMPT. Any further evasion, partial diff, or unverified claim will fail the run and escalate to the Commander.`);
  }

  lines.push('');
  lines.push(`End your response with the required \`## EXECUTION_RECEIPT\` block.`);

  return lines.join('\n');
}
