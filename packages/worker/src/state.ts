import { client } from "./trpc";

let _activeJobId: number | null = null;
let typingInterval: Timer | null = null;

function getActiveJobId(): number | null {
  return _activeJobId;
}

function setActiveJobId(id: number | null): void {
  _activeJobId = id;
}

function startTyping(threadId: string, jobId: number) {
  stopTyping();
  typingInterval = setInterval(async () => {
    await client.typing.mutate({ jobId, threadId }).catch(() => {});
  }, 8_000);
  client.typing.mutate({ jobId, threadId }).catch(() => {});
}

function stopTyping() {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }
}

export { getActiveJobId, setActiveJobId, startTyping, stopTyping };
