import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { prisma } from "../db";
import { discordFetch, postToThread } from "./helpers";

interface Question {
  q: string;
  options: string[];
  recommended: number;
}

interface QaPair {
  q: string;
  a: string;
}

function formatQaBlock(questions: Question[], answers: QaPair[]): string {
  return questions
    .map((q, i) => {
      const a = answers[i]?.a ?? "";
      return `Q: ${q.q}\nA: ${a}`;
    })
    .join("\n\n");
}

async function showNextQuestion(threadId: string, jobId: number, questions: Question[], index: number, reporterId?: string | null) {
  const question = questions[index];
  if (!question) return;
  const total = questions.length;
  const useNumberedBtns = question.options.some(o => o.length > 80);
  const progress = total > 1 ? `Question ${index + 1}/${total}` : "Question";

  const desc = useNumberedBtns
    ? `${question.q}\n\n**Options:**\n${question.options.map((o, i) => {
        const marker = i === question.recommended ? " *(recommended)*" : "";
        return `${i + 1}. ${o}${marker}`;
      }).join("\n")}`
    : question.q;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`❓ ${progress}`)
    .setDescription(desc)
    .setFooter({ text: "Click a button to answer, or type your answer in chat." });

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let currentRow = new ActionRowBuilder<ButtonBuilder>();
  let btnCount = 0;

  for (let i = 0; i < question.options.length; i++) {
    const opt = question.options[i]!;
    const label = useNumberedBtns ? String(i + 1) : (opt.length > 80 ? opt.slice(0, 79) + "…" : opt);

    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`ask_ans:${jobId}:${i}`)
        .setLabel(label)
        .setStyle(i === question.recommended ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
    btnCount++;

    if (btnCount === 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder<ButtonBuilder>();
      btnCount = 0;
    }
  }

  if (btnCount > 0) rows.push(currentRow);

  if (rows.length < 5) {
    const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ask_cancel:${jobId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );
    rows.push(cancelRow);
  }

  const channel = await discordFetch(threadId);
  if (!channel?.isThread()) return;

  if (reporterId) {
    await channel.send({ content: `<@${reporterId}>` });
  }

  const msg = await channel.send({ embeds: [embed], components: rows });

  await prisma.job.update({
    where: { id: jobId },
    data: { statusMessageId: msg.id },
  });
}

async function recordAnswer(jobId: number, answer: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || !job.pendingQuestions) return;

  const questions: Question[] = JSON.parse(job.pendingQuestions);
  if (questions.length === 0) return;
  const pendingAnswers: QaPair[] = job.pendingAnswers ? JSON.parse(job.pendingAnswers) : [];
  const currentIdx = job.pendingQuestionIndex ?? 0;
  const question = questions[currentIdx]!;

  pendingAnswers.push({ q: question.q, a: answer });
  const nextIdx = currentIdx + 1;

  if (job.statusMessageId) {
    try {
      const channel = await discordFetch(job.threadId);
      if (channel?.isThread()) {
        const msg = await channel.messages.fetch(job.statusMessageId);
        const embed = EmbedBuilder.from(msg.embeds[0]!).setColor(0x57F287);
        embed.setTitle((embed.data.title ?? "").replace("❓", "✅"));
        embed.setDescription(`**${question.q}**\n\n📝 *${answer}*`);
        await msg.edit({ embeds: [embed], components: [] });
      }
    } catch { /* message might be gone */ }
  }

  if (nextIdx >= questions.length) {
    await prisma.job.update({
      where: { id: jobId },
      data: {
        pendingQuestionIndex: questions.length,
        pendingAnswers: JSON.stringify(pendingAnswers),
        statusMessageId: null,
      },
    });
    const label = questions.length > 1 ? `${questions.length} questions` : "1 question";
    const mention = job.reporterId ? `<@${job.reporterId}> ` : "";
    await postToThread(job.threadId, `${mention}✅ All ${label} answered.`);
    return;
  }

  await prisma.job.update({
    where: { id: jobId },
    data: {
      pendingQuestionIndex: nextIdx,
      pendingAnswers: JSON.stringify(pendingAnswers),
    },
  });

  await showNextQuestion(job.threadId, jobId, questions, nextIdx, job.reporterId);
}

async function cancelQuestions(jobId: number) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return;

  if (job.statusMessageId) {
    try {
      const channel = await discordFetch(job.threadId);
      if (channel?.isThread()) {
        const msg = await channel.messages.fetch(job.statusMessageId);
        const embed = EmbedBuilder.from(msg.embeds[0]!).setColor(0xED4245);
        embed.setTitle("❌ Cancelled");
        await msg.edit({ embeds: [embed], components: [] });
      }
    } catch { /* message might be gone */ }
  }

  await prisma.job.update({
    where: { id: jobId },
    data: {
      pendingQuestions: null,
      pendingQuestionIndex: null,
      pendingAnswers: null,
      statusMessageId: null,
    },
  });

  const cancelMention = job.reporterId ? `<@${job.reporterId}> ` : "";
  await postToThread(job.threadId, `${cancelMention}❌ Question flow cancelled.`);
}

export { showNextQuestion, recordAnswer, cancelQuestions, formatQaBlock };
