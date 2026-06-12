const activeProcesses = new Set<Bun.Subprocess>();

function trackProcess<T extends Bun.Subprocess>(proc: T): T {
  activeProcesses.add(proc);
  proc.exited
    .then(() => activeProcesses.delete(proc as Bun.Subprocess))
    .catch(() => activeProcesses.delete(proc as Bun.Subprocess));
  return proc;
}

function killAllProcesses(): number {
  let count = 0;
  for (const proc of activeProcesses) {
    try {
      proc.kill();
      count++;
    } catch {
      // process already dead
    }
  }
  activeProcesses.clear();
  return count;
}

export { trackProcess, killAllProcesses };
