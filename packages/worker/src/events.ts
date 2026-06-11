type EventResult = { level: "info" | "debug" | "success"; message: string; append: boolean } | null;

function shortPath(filePath: string, cwd?: string): string {
  if (cwd && filePath.startsWith(cwd)) {
    const rel = filePath.slice(cwd.length).replace(/^\//, "");
    const parts = rel.split("/");
    if (parts.length <= 3) return rel;
    return "…/" + parts.slice(-2).join("/");
  }
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return "…/" + parts.slice(-2).join("/");
}

function formatToolUse(part: any, cwd?: string): EventResult {
  const tool = part.tool as string;
  const state = part.state || {};
  const input = state.input || {};

  switch (tool) {
    case "read": {
      const path = input.filePath || "";
      if (!path) return null;
      const display = state.metadata?.display;
      if (display?.type === "directory") {
        return { message: `📂 \`${shortPath(path, cwd)}\``, level: "debug", append: true };
      }
      return { message: `📖 \`${shortPath(path, cwd)}\``, level: "debug", append: true };
    }

    case "write":
    case "create": {
      const path = input.filePath || input.path || "";
      return { message: `✏️ Writing \`${shortPath(path, cwd)}\``, level: "info", append: true };
    }

    case "edit": {
      const path = input.filePath || "";
      const oldStr = (input.oldString || "").split("\n")[0]?.trim().slice(0, 60) || "";
      const desc = oldStr ? ` — \`${oldStr}…\`` : "";
      return { message: `✏️ Editing \`${shortPath(path, cwd)}\`${desc}`, level: "info", append: true };
    }

    case "delete": {
      const path = input.filePath || "";
      return { message: `🗑️ Deleting \`${shortPath(path, cwd)}\``, level: "info", append: true };
    }

    case "bash": {
      const cmd = (input.command || "").trim();
      if (!cmd) return null;
      const display = cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
      return { message: `💻 \`${display}\``, level: "info", append: true };
    }

    case "grep":
    case "search": {
      const pattern = input.pattern || input.query || "";
      return { message: `🔍 \`${pattern}\``, level: "debug", append: true };
    }

    case "glob": {
      const pattern = input.pattern || "";
      return { message: `🔍 \`${pattern}\``, level: "debug", append: true };
    }

    case "todowrite": {
      const todos = input.todos || [];
      if (!todos.length) return null;
      const statusIcons: Record<string, string> = {
        pending: "🔲",
        in_progress: "🔄",
        completed: "✅",
        cancelled: "❌",
      };
      const lines = todos.map((t: any) => {
        const icon = statusIcons[t.status] || "🔲";
        return `${icon} ${t.content}`;
      });
      return { message: `📋 **Tasks:**\n${lines.join("\n")}`, level: "info", append: true };
    }

    default:
      return null;
  }
}

function handleJsonEvent(event: any, jobId: number, cwd: string): EventResult {
  const type = event.type as string;
  const part = event.part || {};

  switch (type) {
    case "step_start": {
      return { message: "🤔 Analyzing codebase...", level: "info", append: false };
    }

    case "reasoning": {
      const text = (part.text || "").trim();
      if (!text) return null;
      const truncated = text.length > 300 ? text.slice(0, 300) + "…" : text;
      return { message: `💭 ${truncated}`, level: "debug", append: true };
    }

    case "tool_use": {
      if (part.type === "tool") return formatToolUse(part, cwd);
      return null;
    }

    case "text": {
      if (part.type !== "text") return null;
      const text = (part.text || "").trim();
      if (!text) return null;
      const truncated = text.length > 500 ? text.slice(0, 500) + "…" : text;
      return { message: truncated, level: "info", append: true };
    }

    case "step_finish": {
      if (part.reason === "stop") {
        return { message: "✅ Task complete", level: "success", append: false };
      }
      return null;
    }

    default:
      return null;
  }
}

export { type EventResult, handleJsonEvent };
