const activeProcesses = new Set<Bun.Subprocess>();

function trackProcess<T extends Bun.Subprocess>(proc: T): T {
  activeProcesses.add(proc);
  proc.exited
    .then(() => activeProcesses.delete(proc as Bun.Subprocess))
    .catch(() => activeProcesses.delete(proc as Bun.Subprocess));
  return proc;
}

async function killAllProcesses(timeoutMs = 10_000): Promise<number> {
  const procs = [...activeProcesses];
  if (procs.length === 0) return 0;

  // Step 1: Send SIGINT to all children (graceful shutdown)
  for (const proc of procs) {
    try {
      proc.kill(2);
    } catch {
      // process already dead
    }
  }

  // Step 2: Wait for them to exit
  const waitPromises = procs.map(p => p.exited.catch(() => {}));
  const timeout = new Promise<void>(resolve => setTimeout(resolve, timeoutMs));
  await Promise.race([Promise.all(waitPromises), timeout]);

  // Step 3: SIGKILL any survivors
  let killed = 0;
  for (const proc of procs) {
    if (!activeProcesses.has(proc)) continue;
    try {
      proc.kill(9);
      killed++;
    } catch {
      // already dead
    }
  }

  activeProcesses.clear();
  return killed;
}

export { trackProcess, killAllProcesses };
