---
name: codex-commander
description: >-
  Standard operating procedure for Antigravity to command, audit, push back on
  evasive responses from, and review OpenAI Codex CLI workers via the agy-codex
  orchestrator. Activate whenever dispatching coding tasks to Codex, resuming a
  Codex session, running parallel Codex worktree queues, or handling evasive
  Codex replies.
---

# Codex Commander SOP (Antigravity -> Codex)

When acting as Commander directing Codex via `agy-codex`:

## 1. Environment Check & Pre-Dispatch Model Selection
Before the first real dispatch in a session, verify the Codex binary is reachable and check available models:
```powershell
node bin/agy-codex.mjs doctor
node bin/agy-codex.mjs models
```
- **Model Selection Before Starting a Conversation**: Before dispatching a new Codex conversation (`dispatch`), if the user has not already specified a model, list the available models from `node bin/agy-codex.mjs models` and ask the user to choose a model (putting the current default first as `(Recommended)`), then pass `--model <slug>` to `dispatch`.
- **Sandbox Bypass**: When a task requires network access (e.g., NAS SSH) or cross-workspace operations, pass `--bypass-sandbox` (or set `"bypassSandbox": true` in the task JSON) so Codex receives `--dangerously-bypass-approvals-and-sandbox`.
- **External Session Attach**: To continue an existing local Codex CLI session (`~/.codex/sessions`), pass `--session <session-id>` to `dispatch`. Note: ChatGPT-hosted cloud threads in Codex Desktop (`source_kind: "chatgpt"`) have no local rollout and cannot be resumed via `codex exec resume`; start a new local Codex CLI session in the target repository instead.

## 2. Authoring Airtight Task Specs
Never send vague one-liners to Codex—vague prompts invite clarifying questions and plan-only replies.
Create a task JSON (or pass structured CLI flags) containing:
- `objective`: Exact end state, not open-ended discussion.
- `targetFiles`: Concrete relative paths to create or edit.
- `constraints`: Hard boundaries (no TODOs, no unrelated refactors, follow existing style).
- `acceptanceCriteria`: Observable, verifiable conditions.
- `verifyCommands`: Exact commands Codex and the verifier must pass (exit code 0).
- `expectChanges`: `true` for implementation tasks, `false` for pure audit/analysis tasks.

## 3. Dispatching & Anti-Evasion Enforcement
Run:
```powershell
node bin/agy-codex.mjs dispatch --task tasks/<task>.json
```
Or ad-hoc:
```powershell
node bin/agy-codex.mjs dispatch --title "Fix parser" --objective "..." --cwd <repo> --target src/parser.mjs --verify "npm test"
```

The orchestrator automatically:
1. Wraps the task in the non-interactive `COMMANDER DIRECTIVE` protocol requiring direct execution and an `EXECUTION_RECEIPT`.
2. Runs `codex exec --json --output-last-message ...` and captures the `session_id` / `thread_id`.
3. Verifies actual workspace file deltas (`git status` / `git diff`) and runs `verifyCommands`.
4. Runs `analyzeEvasion()` to catch:
   - Clarification/confirmation deflection ("Would you like me to...", "请问...")
   - Advice/plan-only responses without modifying files
   - Zero-diff claims when changes were required
   - Deferred work / TODO stubs in text or `git diff`
   - Unverified "should work" claims
   - Premature surrender ("please run manually")
   - Missing `EXECUTION_RECEIPT`
5. If evasion or test failure is detected, automatically builds an escalating `COMMANDER PUSHBACK DIRECTIVE` and resumes the **same Codex session** (`codex exec resume <session_id>`).

## 4. Commander Review & Manual Pushback
Always inspect the generated review report before accepting work:
```powershell
node bin/agy-codex.mjs review --run <run-id>
```
- If `status` is `passed`: read `runs/<run-id>/diff.patch` to verify code quality, then accept or merge the worktree branch.
- If `status` is `evasion_escalated` or `verification_failed`: issue a pointed follow-up directive on the same session:
```powershell
node bin/agy-codex.mjs resume --run <run-id> --note "Do not ask questions. Implement X in src/foo.mjs and make npm test pass."
```
- If Codex repeatedly evades after 3+ attempts, break the task into a smaller, single-file atomic spec or take over the critical edit directly.

## 5. Parallel Worktree Queues
For independent tasks in a git repository, run them in parallel with isolated worktrees:
```powershell
node bin/agy-codex.mjs queue --file tasks/batch.json --concurrency 2 --worktree
```
After reviewing and merging each branch (`agy-codex/<run-id>`), clean up worktrees:
```powershell
node bin/agy-codex.mjs cleanup-worktree --run <run-id> --delete-branch
```
