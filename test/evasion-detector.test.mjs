import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvasion } from '../src/evasion-detector.mjs';
import { buildInitialDirective, buildPushbackDirective } from '../src/prompt-builder.mjs';

test('detects clarification and advice-only deflection in English & Chinese', () => {
  const res = analyzeEvasion({
    task: { id: 't1', title: 'Fix bug', expectChanges: true, verifyCommands: ['npm test'] },
    responseText:
      'Before I proceed, could you clarify which approach you prefer? Here is how you can fix it manually: update src/app.js. 请确认是否需要我继续？',
    verification: { changedFiles: [], allPassed: true, checks: [], diffText: '' },
    exitCode: 0,
  });

  assert.equal(res.detected, true);
  assert.equal(res.severity, 'blocking');
  assert.equal(res.recommendedAction, 'resume_pushback');
  assert.ok(res.categories.includes('clarification_deflection'));
  assert.ok(res.categories.includes('advice_only_deflection'));
  assert.ok(res.categories.includes('zero_diff_claim'));
});

test('detects deferred work and TODO placeholders in git diff', () => {
  const res = analyzeEvasion({
    task: { id: 't2', title: 'Implement parser', expectChanges: true, verifyCommands: [] },
    responseText: [
      'I have outlined the first part; omitted for brevity, let me know if you want me to implement the rest.',
      '## EXECUTION_RECEIPT',
      'STATUS: COMPLETED',
      'CHANGED_FILES: src/parser.mjs',
      'VERIFICATION: none',
    ].join('\n'),
    verification: {
      changedFiles: ['src/parser.mjs'],
      allPassed: true,
      checks: [],
      diffText: '+++ b/src/parser.mjs\n+// TODO: implement remaining tokens\n+throw new Error("not implemented");\n',
    },
    exitCode: 0,
  });

  assert.equal(res.detected, true);
  assert.equal(res.severity, 'blocking');
  assert.ok(res.categories.includes('deferred_work'));
  assert.ok(res.categories.includes('diff_placeholders'));
});

test('accepts clean execution with real changes and structured receipt', () => {
  const res = analyzeEvasion({
    task: { id: 't3', title: 'Add helper', expectChanges: true, verifyCommands: ['npm test'] },
    responseText: [
      'Implemented helper in src/helper.mjs and verified all unit tests pass.',
      '',
      '## EXECUTION_RECEIPT',
      'STATUS: COMPLETED',
      'CHANGED_FILES: src/helper.mjs',
      'VERIFICATION: npm test (exit 0)',
      'DECISIONS: NONE',
      'BLOCKER_EVIDENCE: NONE',
    ].join('\n'),
    verification: {
      changedFiles: ['src/helper.mjs'],
      allPassed: true,
      checks: [{ command: 'npm test', passed: true, exitCode: 0 }],
      diffText: '+++ b/src/helper.mjs\n+export const sum = (a, b) => a + b;\n',
    },
    exitCode: 0,
  });

  assert.equal(res.detected, false);
  assert.equal(res.severity, 'none');
  assert.equal(res.recommendedAction, 'accept');
});

test('prompt builder produces initial directive and escalating pushback', () => {
  const task = {
    id: 't4',
    title: 'Fix auth',
    objective: 'Fix token refresh',
    targetFiles: ['src/auth.mjs'],
    verifyCommands: ['npm test'],
  };
  const initial = buildInitialDirective(task);
  assert.match(initial, /MANDATORY EXECUTION PROTOCOL/);
  assert.match(initial, /EXECUTION_RECEIPT/);

  const pushback2 = buildPushbackDirective({
    task,
    attemptNumber: 2,
    evasionReport: {
      detected: true,
      score: 80,
      severity: 'blocking',
      categories: ['clarification_deflection', 'zero_diff_claim'],
      findings: [{ category: 'zero_diff_claim', summary: '0 changed files', evidence: ['git=0'] }],
    },
    verification: { allPassed: true, checks: [] },
  });
  assert.match(pushback2, /FIRM_CORRECTION/);
  assert.match(pushback2, /STOP asking questions/);

  const pushback3 = buildPushbackDirective({
    task,
    attemptNumber: 3,
    evasionReport: { detected: true, score: 80, severity: 'blocking', categories: ['deferred_work'], findings: [] },
    verification: { allPassed: true, checks: [] },
  });
  assert.match(pushback3, /FINAL_ZERO_TOLERANCE/);
});
