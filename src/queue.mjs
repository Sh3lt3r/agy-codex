import { dispatchTask } from './orchestrator.mjs';

/**
 * Serial or parallel task queue runner with bounded concurrency
 * and optional git worktree isolation per task.
 */
export async function runTaskQueue({
  tasks,
  config,
  baseDir = process.cwd(),
  concurrency = null,
  useWorktree = false,
  mock = false,
  mockScenario = 'clean',
  onEvent = null,
}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('Queue contains no tasks.');
  }

  const maxWorkers = Math.max(
    1,
    Number(concurrency || config.orchestrator?.defaultConcurrency || 1)
  );
  const results = new Array(tasks.length);
  let cursor = 0;

  async function worker(workerIndex) {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) break;
      const task = tasks[idx];
      if (onEvent) {
        onEvent({ type: 'queue_start', workerIndex, index: idx, taskId: task.id });
      }
      try {
        const res = await dispatchTask({
          task,
          config,
          baseDir,
          useWorktree: useWorktree || Boolean(task.useWorktree),
          mock,
          mockScenario: task.mockScenario || mockScenario,
          onEvent,
        });
        results[idx] = { ok: res.summary.status === 'passed', ...res };
      } catch (err) {
        results[idx] = {
          ok: false,
          taskId: task.id,
          error: err.message,
        };
      }
      if (onEvent) {
        onEvent({
          type: 'queue_done',
          workerIndex,
          index: idx,
          taskId: task.id,
          status: results[idx].summary?.status || 'error',
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(maxWorkers, tasks.length) }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const passed = results.filter((r) => r.ok).length;
  return {
    total: tasks.length,
    passed,
    failed: tasks.length - passed,
    results,
  };
}
