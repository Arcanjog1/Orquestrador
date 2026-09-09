export interface DelegationTask {
  taskKind?: string;
  taskId: string;
  workerId: string;
  task: string;
  dependsOn: string[];
  requiresTools: boolean;
}

export function validateDelegations(value: unknown): DelegationTask[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8)
    throw new Error("delegations must contain at most 8 tasks.");
  const ids = new Set<string>();
  const tasks = value.map((item: unknown) => {
    if (!item || typeof item !== "object")
      throw new Error("Invalid delegation.");
    const row = item as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (k) =>
          ![
            "taskKind",
            "taskId",
            "workerId",
            "task",
            "dependsOn",
            "requiresTools",
          ].includes(k),
      )
    )
      throw new Error("Unknown delegation field.");
    if (
      typeof row.taskId !== "string" ||
      !/^[\w-]{1,80}$/.test(row.taskId) ||
      ids.has(row.taskId)
    )
      throw new Error("Task ids must be unique identifiers.");
    if (
      typeof row.workerId !== "string" ||
      !row.workerId.trim() ||
      typeof row.task !== "string" ||
      !row.task.trim() ||
      !Array.isArray(row.dependsOn) ||
      !row.dependsOn.every((d) => typeof d === "string") ||
      typeof row.requiresTools !== "boolean"
    )
      throw new Error(
        "Each task needs workerId, task, dependsOn and requiresTools.",
      );
    ids.add(row.taskId);
    return {
      ...(typeof row.taskKind==='string'?{taskKind:row.taskKind}:{}),
      taskId: row.taskId,
      workerId: row.workerId,
      task: row.task,
      dependsOn: row.dependsOn as string[],
      requiresTools: row.requiresTools,
    };
  });
  for (const task of tasks)
    if (task.dependsOn.some((id) => !ids.has(id) || id === task.taskId))
      throw new Error("Unknown or self dependency.");
  const completed = new Set<string>();
  while (completed.size < tasks.length) {
    const ready = tasks.filter(
      (t) =>
        !completed.has(t.taskId) &&
        t.dependsOn.every((id) => completed.has(id)),
    );
    if (!ready.length) throw new Error("Cyclic dependencies.");
    ready.forEach((t) => completed.add(t.taskId));
  }
  return tasks;
}

/** Picks independent work, one task per runtime/account; local writes stay serial. */
export function readyDelegations(
  tasks: readonly DelegationTask[],
  completed: ReadonlySet<string>,
  pending: ReadonlySet<string>,
  resource: (task: DelegationTask) => string,
  concurrency: number,
): DelegationTask[] {
  const selected: DelegationTask[] = [],
    busy = new Set<string>();
  for (const task of tasks) {
    if (
      !pending.has(task.taskId) ||
      !task.dependsOn.every((id) => completed.has(id))
    )
      continue;
    const key = resource(task);
    if (busy.has(key)) continue;
    selected.push(task);
    busy.add(key);
    if (selected.length >= concurrency) break;
  }
  return selected;
}
