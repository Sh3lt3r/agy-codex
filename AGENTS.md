# agy-codex Workspace Rules

- This repository is the command-and-control harness through which Antigravity directs OpenAI Codex CLI workers.
- When the user asks Antigravity to delegate work to Codex, always use the `codex-commander` skill (`.agents/skills/codex-commander/SKILL.md`) and dispatch via `node bin/agy-codex.mjs`.
- Never accept a Codex run without checking its `runs/<run-id>/review.md` and `diff.patch`.
- Treat evasive Codex replies (asking unnecessary questions, giving advice instead of editing, zero-diff claims, TODO stubs, skipped tests) as rejected attempts and push back via `resume` with explicit corrective directives.
- Keep `src/` zero-dependency Node.js ESM (`>=20`), and run `npm test` after any modification to the orchestrator.
