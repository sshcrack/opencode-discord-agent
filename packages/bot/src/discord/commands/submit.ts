import { SlashCommandBuilder, CommandInteraction, Message, Collection, ThreadChannel } from "discord.js";
import { prisma } from "../../db";
import { runFallback, checkWorkerOnline } from "../fallback";
import { buildContext } from "../context";
import { Command } from "./Command";

async function generateIssueOnBot(
  jobId: number,
  thread: ThreadChannel,
  context: string,
  repoSlug: string,
  kind: string,
) {
  const repo = await prisma.repository.findUnique({ where: { slug: repoSlug } });
  if (!repo) return;

  const setting = await prisma.setting.findUnique({ where: { key: "issue_model" } });
  const model = setting?.value ?? "opencode/big-pickle";

  const prompt = [
    `Create a well-structured GitHub issue for the following ${kind} report.`,
    `Repository: ${repoSlug}`,
    ``,
    `# Output ONLY:`,
    `Line 1: Issue title (plain text, no markdown heading prefix)`,
    `Line 2+: Issue body in Markdown`,
    ``,
    `## Report context:`,
    `Kind: ${kind}`,
    `Repo: ${repoSlug}`,
    ...(context ? [`\nDiscord thread context:\n${context}`] : []),
  ].join("\n");

  const proc = Bun.spawn(
    ["opencode", "run", "--model", model, "--print", prompt],
    { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
  );

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) return;

  const lines = output.trim().split("\n");
  const title = lines[0]?.replace(/^#+\s*/, "").trim() || `[${repoSlug}] ${kind} report`;
  const body = lines.slice(1).join("\n").trim() || `Automated ${kind} report for ${repoSlug}`;

  const repoView = Bun.spawn(
    ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
  );
  const repoViewOut = await new Response(repoView.stdout).text();
  const repoViewExit = await repoView.exited;
  const repoNameWithOwner = repoViewExit === 0 ? repoViewOut.trim() : "";

  const ghArgs = [
    "issue", "create",
    "--title", title,
    "--body", body,
    ...(repoNameWithOwner ? ["--repo", repoNameWithOwner] : []),
  ];

  const ghProc = Bun.spawn(["gh", ...ghArgs], {
    cwd: repo.path,
    stdout: "pipe",
    stderr: "pipe",
  });

  const ghOutput = await new Response(ghProc.stdout).text();
  const ghExit = await ghProc.exited;

  if (ghExit !== 0) return;

  const match = ghOutput.trim().match(/\/(\d+)$/);
  if (!match || !match[1]) return;

  const issueNumber = parseInt(match[1]);

  await prisma.job.update({ where: { id: jobId }, data: { issueNumber } });

  const newName = `#${issueNumber} ${title}`.slice(0, 100);
  await thread.setName(newName).catch(() => {});

  const issueUrl = ghOutput.trim();
  await thread.send(`✅ Issue created: ${issueUrl}`);
}

export class SubmitCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("submit")
    .setDescription("Submit the current report thread as a job")
    .addBooleanOption(o =>
      o.setName("auto").setDescription("Override auto-mode for this job").setRequired(false),
    ) as SlashCommandBuilder;

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({
        content: ":x: This command can only be used inside a report thread",
        ephemeral: true,
      });
      return;
    }

    const reportThread = await prisma.reportThread.findUnique({ where: { threadId: thread.id } });
    if (!reportThread) {
      await interaction.reply({ content: ":x: This thread is not a valid report thread", ephemeral: true });
      return;
    }

    const autoOverride = interaction.options.getBoolean("auto");
    const autoSetting = await prisma.setting.findUnique({ where: { key: "auto_mode" } });
    const autoMode = autoOverride ?? autoSetting?.value === "on";

    const messages: Message[] = [];
    let lastId: string | undefined;

    while (true) {
      const fetched: Collection<string, Message> = await thread.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
      if (fetched.size === 0) break;
      messages.push(...fetched.values());
      const last = fetched.last();
      if (!last) break;
      lastId = last.id;
      if (fetched.size < 100) break;
    }

    const context = await buildContext(messages);

    const job = await prisma.job.create({
      data: {
        threadId: thread.id,
        repoSlug: reportThread.repoSlug,
        kind: reportThread.kind,
        status: "pending",
        autoMode,
        context,
      },
    });

    await interaction.reply(`ℹ️ Job #${job.id} created, generating issue...`);

    await generateIssueOnBot(job.id, thread, context, reportThread.repoSlug, reportThread.kind);

    const online = await checkWorkerOnline();
    if (!online) {
      await runFallback(job.id, context, reportThread.repoSlug, thread.id);
    }
  }
}
