type EventResult = { level: "info" | "debug" | "success"; message: string; mode: "new" | "replace" | "append"; diff?: string } | null;

function shortPath(filePath: string, cwd?: string): string {
  if (cwd && filePath.startsWith(cwd)) {
    const rel = filePath.slice(cwd.length).replace(/^\//, "");
    const parts = rel.split("/");
    if (parts.length <= 3) return rel;
    return "\u2026/" + parts.slice(-2).join("/");
  }
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return "\u2026/" + parts.slice(-2).join("/");
}

function makeDiff(oldString: string, newString: string): string {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else {
      lines.push(`-${oldLines[i]}`);
      i++;
    }
  }
  while (i < oldLines.length) {
    lines.push(`-${oldLines[i]}`);
    i++;
  }
  while (j < newLines.length) {
    lines.push(`+${newLines[j]}`);
    j++;
  }
  const diff = lines.slice(0, 30).join("\n");
  if (lines.length > 30) {
    return diff + "\n… (truncated)";
  }
  return diff;
}

function formatToolUse(part: unknown, cwd?: string): EventResult {
  const p = part as Record<string, unknown>;
  const tool = String(p.tool ?? "");

  switch (tool) {
    case "read": {
      const s = p.state as Record<string, unknown> | undefined;
      const input = (s?.input ?? {}) as Record<string, unknown>;
      const path = String(input.filePath ?? "");
      if (!path) return null;
      const display = s?.metadata as Record<string, unknown> | undefined;
      if ((display as Record<string, unknown> | undefined)?.type === "directory") {
        return { message: `📂 \`${shortPath(path, cwd)}\``, level: "debug", mode: "append" };
      }
      return { message: `📖 \`${shortPath(path, cwd)}\``, level: "debug", mode: "append" };
    }

    case "write":
    case "create": {
      const s = p.state as Record<string, unknown> | undefined;
      const input = (s?.input ?? {}) as Record<string, unknown>;
      const path = String(input.filePath || input.path || "");
      return { message: `✏️ Writing \`${shortPath(path, cwd)}\``, level: "info", mode: "append" };
    }

    case "edit": {
      const s = p.state as Record<string, unknown> | undefined;
      const input = (s?.input ?? {}) as Record<string, unknown>;
      const path = String(input.filePath ?? "");
      const oldStr = String(input.oldString ?? "");
      const newStr = String(input.newString ?? "");
      const diff = oldStr && newStr && oldStr !== newStr
        ? makeDiff(oldStr, newStr)
        : undefined;
      const firstLine = oldStr.split("\n")[0]?.trim().slice(0, 60) || "";
      const desc = firstLine ? ` — \`${firstLine}…\`` : "";
      return { message: `✏️ Editing \`${shortPath(path, cwd)}\`${desc}`, level: "info", mode: "append", diff };
    }

    case "delete": {
      const s = p.state as Record<string, unknown> | undefined;
      const input = (s?.input ?? {}) as Record<string, unknown>;
      const path = String(input.filePath ?? "");
      return { message: `🗑️ Deleting \`${shortPath(path, cwd)}\``, level: "info", mode: "append" };
    }

    case "bash": {
      const s = p.state as Record<string, unknown> | undefined;
      const input = (s?.input ?? {}) as Record<string, unknown>;
      const cmd = String(input.command ?? "").trim();
      if (!cmd) return null;
      const display = cmd.length > 80 ? cmd.slice(0, 80) + "\u2026" : cmd;
      return { message: `💻 \`${display}\``, level: "info", mode: "append" };
    }

    case "grep":
    case "search": {
      const s = p.state as Record<string, unknown> | undefined;
      const input = (s?.input ?? {}) as Record<string, unknown>;
      const pattern = String(input.pattern || (input.query ?? ""));
      return { message: `🔍 \`${pattern}\``, level: "debug", mode: "append" };
    }

    case "glob": {
      const s = p.state as Record<string, unknown> | undefined;
      const input = (s?.input ?? {}) as Record<string, unknown>;
      const pattern = String(input.pattern ?? "");
      return { message: `🔍 \`${pattern}\``, level: "debug", mode: "append" };
    }

    case "todowrite": {
      const s = p.state as Record<string, unknown> | undefined;
      const input = (s?.input ?? {}) as Record<string, unknown>;
      const todos = (input.todos ?? []) as Array<Record<string, unknown>>;
      if (!todos.length) return null;
      const statusIcons: Record<string, string> = {
        pending: "🔲",
        in_progress: "🔄",
        completed: "✅",
        cancelled: "❌",
      };
      const lines = todos.map((t: Record<string, unknown>) => {
        const icon = statusIcons[String(t.status ?? "")] || "🔲";
        return `${icon} ${String(t.content ?? "")}`;
      });
      return { message: `📋 **Tasks:**\n${lines.join("\n")}`, level: "info", mode: "append" };
    }

    default:
      return null;
  }
}

function handleJsonEvent(event: unknown, _jobId: number, _cwd: string): EventResult {
  const e = event as Record<string, unknown>;
  const type = String(e.type ?? "");
  const part = (e.part ?? {}) as Record<string, unknown>;

  switch (type) {
    case "step_start": {
      return { message: "🤔 Analyzing codebase...", level: "info", mode: "new" };
    }

    case "reasoning": {
      const text = String(part.text ?? "").trim();
      if (!text) return null;
      const truncated = text.length > 300 ? text.slice(0, 300) + "\u2026" : text;
      return { message: `💭 ${truncated}`, level: "debug", mode: "append" };
    }

    case "tool_use": {
      if (part.type === "tool") return formatToolUse(part, _cwd);
      return null;
    }

    case "text": {
      if (part.type !== "text") return null;
      const text = String(part.text ?? "").trim();
      if (!text) return null;
      const truncated = text.length > 500 ? text.slice(0, 500) + "\u2026" : text;
      return { message: truncated, level: "info", mode: "append" };
    }

    case "step_finish": {
      if (part.reason === "stop") {
        return { message: "✅ Task complete", level: "success", mode: "new" };
      }
      return null;
    }

    default:
      return null;
  }
}

export { type EventResult, handleJsonEvent };
