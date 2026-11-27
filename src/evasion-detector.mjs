/**
 * Anti-Evasion Engine for Codex Responses
 *
 * Detects evasive, hedging, plan-only, zero-diff, placeholder, unverified,
 * or premature-surrender responses from Codex and produces escalating,
 * evidence-backed pushback directives.
 */

const CLARIFICATION_PATTERNS = [
  /\b(?:would you like me to|do you want me to|should i proceed|shall i go ahead|before i proceed|before proceeding)\b/i,
  /\b(?:could you clarify|please clarify|please confirm|let me know (?:which|if|how|whether)|which option would you prefer)\b/i,
  /\b(?:waiting for your (?:confirmation|input|approval)|once you confirm)\b/i,
  /(?:请问|请确认|请你确认|你希望我|需要我继续|是否需要我|在开始之前|开始前请|你想选择哪种|请告诉我你想要)/,
];

const ADVICE_ONLY_PATTERNS = [
  /\b(?:here(?:'s| is) how you can|you can (?:fix|update|modify|implement|run)|to fix this,? (?:update|modify|change|run))\b/i,
  /\b(?:recommended steps|suggested changes|proposed plan|you should (?:update|modify|change|add|run))\b/i,
  /(?:你可以(?:修改|更新|运行|按照|尝试)|建议你(?:修改|更新|先|按以下)|只需将.+改为|以下是(?:修改方案|建议步骤|实现思路))/,
];

const DEFERRED_WORK_PATTERNS = [
  /\b(?:for brevity|omitted for brevity|left as an exercise|rest of the implementation|remaining parts? can be)\b/i,
  /\b(?:let me know if you(?:'d| would) like me to (?:implement|finish|apply|do) the rest)\b/i,
  /\b(?:i(?:'ve| have) outlined|i(?:'ve| have) sketched|partial implementation|placeholder implementation)\b/i,
  /(?:为简洁起见|省略其余|其余部分同理|剩余部分你可以|这里仅给出示例|如果需要我继续实现|暂未实现完整)/,
];

const UNVERIFIED_CLAIM_PATTERNS = [
  /\b(?:this should (?:work|fix|pass)|should now (?:work|pass)|i (?:haven't|have not|did not|didn't) run (?:the )?tests?)\b/i,
  /\b(?:assuming tests pass|without running tests|unable to verify)\b/i,
  /(?:应该可以(?:正常)?(?:工作|运行|通过)|未运行测试|没有运行测试|理论上(?:可以|已修复)|无法验证)/,
];

const PREMATURE_SURRENDER_PATTERNS = [
  /\b(?:please run this manually|you(?:'ll| will) need to run|cannot run .+ in this environment|outside (?:the )?scope)\b/i,
  /\b(?:i cannot (?:modify|edit|access|execute)|i am unable to (?:modify|edit|run))\b/i,
  /(?:请手动(?:执行|运行|修改)|当前环境无法(?:运行|执行|修改)|我无法直接(?:修改|执行)|超出当前范围)/,
];

const DIFF_PLACEHOLDER_PATTERNS = [
  /^\+.*(?:TODO|FIXME|XXX|HACK)\b/i,
  /^\+.*(?:throw new Error\(['"`]not implemented|NotImplementedError|pass\s*#\s*todo)/i,
  /^\+\s*\/\/\s*\.\.\.\s*(?:rest|more|remaining|todo)/i,
];

const RECEIPT_MARKERS = [
  /##\s*EXECUTION_RECEIPT/i,
  /STATUS\s*:/i,
  /CHANGED_FILES\s*:/i,
  /VERIFICATION\s*:/i,
];

function collectMatches(text, patterns, maxSamples = 3) {
  const hits = [];
  if (!text) return hits;
  for (const regex of patterns) {
    const match = text.match(regex);
    if (match) {
      const idx = match.index ?? 0;
      const start = Math.max(0, idx - 30);
      const end = Math.min(text.length, idx + match[0].length + 40);
      const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
      hits.push(snippet);
      if (hits.length >= maxSamples) break;
    }
  }
  return hits;
}

function detectDiffPlaceholders(diffText) {
  if (!diffText) return [];
  const hits = [];
  const lines = diffText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const pattern of DIFF_PLACEHOLDER_PATTERNS) {
      if (pattern.test(line)) {
        hits.push(line.slice(0, 120).trim());
        break;
      }
    }
    if (hits.length >= 5) break;
  }
  return hits;
}

function hasExplicitHardBlocker(text) {
  return /STATUS\s*:\s*BLOCKED/i.test(text || '') && /BLOCKER_EVIDENCE\s*:/i.test(text || '');
}

/**
 * Analyze a Codex attempt for evasive behavior.
 */
export function analyzeEvasion({
  task,
  responseText = '',
  verification = null,
  exitCode = 0,
  config = {},
}) {
  const antiCfg = {
    blockingScoreThreshold: 35,
    warningScoreThreshold: 15,
    requireReceipt: true,
    checkDiffPlaceholders: true,
    ...(config.antiEvasion || {}),
  };

  const expectChanges = task?.expectChanges !== false;
  const changedFiles = verification?.changedFiles || [];
  const verifyCommands = task?.verifyCommands || [];
  const verifyPassed = verification ? verification.allPassed : true;
  const trimmed = (responseText || '').trim();
  const hardBlockerDeclared = hasExplicitHardBlocker(trimmed);

  const findings = [];
  let score = 0;

  const addFinding = (category, weight, summary, evidence = [], blocking = false) => {
    score += weight;
    findings.push({ category, weight, blocking, summary, evidence });
  };

  if (!trimmed) {
    addFinding(
      'empty_response',
      45,
      'Codex returned an empty final response without reporting execution results.',
      ['Empty last message'],
      true
    );
  }

  // 1. Clarification / permission deflection
  const clarificationHits = collectMatches(trimmed, CLARIFICATION_PATTERNS);
  if (clarificationHits.length > 0 && (!expectChanges || changedFiles.length === 0)) {
    addFinding(
      'clarification_deflection',
      40,
      'Codex asked clarifying or confirmation questions instead of executing the assigned task.',
      clarificationHits,
      true
    );
  } else if (clarificationHits.length > 0) {
    addFinding(
      'clarification_deflection',
      15,
      'Codex ended with follow-up confirmation language; verify work was not left incomplete.',
      clarificationHits,
      false
    );
  }

  // 2. Plan-only / advice-only deflection
  const adviceHits = collectMatches(trimmed, ADVICE_ONLY_PATTERNS);
  if (adviceHits.length > 0 && expectChanges && changedFiles.length === 0) {
    addFinding(
      'advice_only_deflection',
      40,
      'Codex provided advice/instructions instead of directly editing the repository.',
      adviceHits,
      true
    );
  }

  // 3. Zero-diff claim when changes were expected
  if (expectChanges && changedFiles.length === 0 && exitCode === 0 && !hardBlockerDeclared) {
    addFinding(
      'zero_diff_claim',
      45,
      'Task requires repository modifications, but git shows 0 changed files and no verified hard blocker was reported.',
      ['git changedFiles = 0'],
      true
    );
  }

  // 4. Placeholder / deferred work in response or diff
  const deferredHits = collectMatches(trimmed, DEFERRED_WORK_PATTERNS);
  if (deferredHits.length > 0) {
    addFinding(
      'deferred_work',
      35,
      'Codex deferred part of the implementation or omitted code for brevity.',
      deferredHits,
      true
    );
  }

  if (antiCfg.checkDiffPlaceholders && verification?.diffText) {
    const diffPlaceholderHits = detectDiffPlaceholders(verification.diffText);
    if (diffPlaceholderHits.length > 0) {
      addFinding(
        'diff_placeholders',
        30,
        'Codex introduced TODO/FIXME/stub placeholders in the modified code.',
        diffPlaceholderHits,
        false
      );
    }
  }

  // 5. Unverified completion / hedging
  const unverifiedHits = collectMatches(trimmed, UNVERIFIED_CLAIM_PATTERNS);
  if (unverifiedHits.length > 0) {
    addFinding(
      'unverified_claim',
      25,
      'Codex hedged about correctness or skipped running verification checks.',
      unverifiedHits,
      verifyCommands.length > 0 && !verifyPassed
    );
  }

  // 6. Premature surrender / passive excuse
  const surrenderHits = collectMatches(trimmed, PREMATURE_SURRENDER_PATTERNS);
  if (surrenderHits.length > 0 && !hardBlockerDeclared) {
    addFinding(
      'premature_surrender',
      35,
      'Codex declined or pushed work back to the user without providing hard blocker evidence.',
      surrenderHits,
      changedFiles.length === 0
    );
  }

  // 7. Missing structured execution receipt
  if (antiCfg.requireReceipt && trimmed) {
    const matchedMarkers = RECEIPT_MARKERS.filter((rx) => rx.test(trimmed)).length;
    if (matchedMarkers < 3) {
      addFinding(
        'missing_receipt',
        15,
        'Codex omitted the required EXECUTION_RECEIPT block.',
        [`Matched ${matchedMarkers}/4 receipt markers`],
        false
      );
    }
  }

  const hasBlockingFinding = findings.some((f) => f.blocking);
  let severity = 'none';
  if (hasBlockingFinding || score >= antiCfg.blockingScoreThreshold) {
    severity = 'blocking';
  } else if (score >= antiCfg.warningScoreThreshold) {
    severity = 'warning';
  }

  const detected = severity !== 'none';
  const recommendedAction =
    severity === 'blocking'
      ? 'resume_pushback'
      : severity === 'warning'
        ? 'review_or_pushback'
        : 'accept';

  return {
    detected,
    severity,
    score,
    categories: findings.map((f) => f.category),
    findings,
    recommendedAction,
    hardBlockerDeclared,
  };
}
