import { spawn } from "node:child_process";
import { postStatus } from "./reporter";

export async function run(
  jobId: string,
  worktreeDir: string,
): Promise<void> {
  await postStatus(jobId, "🏗️ Build agent starting…");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "opencode",
      ["run", "--agent", "build", "Follow PLAN.md exactly. Do not deviate from the plan."],
      {
        cwd: worktreeDir,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      },
    );

    let output = "";

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      for (const line of text.split("\n").filter(Boolean)) {
        console.log(`[builder] ${line}`);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      for (const line of text.split("\n").filter(Boolean)) {
        console.error(`[builder:err] ${line}`);
      }
    });

    child.on("close", async (code) => {
      if (code === 0) {
        resolve();
      } else {
        await postStatus(
          jobId,
          `❌ Build agent exited with code ${code}.\n\`\`\`\n${output.slice(-1500)}\n\`\`\``,
          "error",
        );
        reject(new Error(`Build agent exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}
