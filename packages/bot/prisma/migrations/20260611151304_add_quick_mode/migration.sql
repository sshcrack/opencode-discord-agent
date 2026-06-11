-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Job" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "threadId" TEXT NOT NULL,
    "repoSlug" TEXT NOT NULL,
    "repoPath" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "context" TEXT,
    "workerId" TEXT,
    "reporterId" TEXT,
    "planMd" TEXT,
    "opencodeSessionId" TEXT,
    "issueNumber" INTEGER,
    "prUrl" TEXT,
    "autoMode" BOOLEAN NOT NULL DEFAULT false,
    "quickMode" BOOLEAN NOT NULL DEFAULT false,
    "pendingSuggestion" TEXT,
    "planEditToken" TEXT,
    "statusMessageId" TEXT,
    "pendingQuestions" TEXT,
    "pendingQuestionIndex" INTEGER,
    "pendingAnswers" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Job_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ReportThread" ("threadId") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Job" ("autoMode", "context", "createdAt", "id", "issueNumber", "kind", "opencodeSessionId", "pendingAnswers", "pendingQuestionIndex", "pendingQuestions", "pendingSuggestion", "planEditToken", "planMd", "prUrl", "repoPath", "repoSlug", "reporterId", "status", "statusMessageId", "threadId", "updatedAt", "workerId") SELECT "autoMode", "context", "createdAt", "id", "issueNumber", "kind", "opencodeSessionId", "pendingAnswers", "pendingQuestionIndex", "pendingQuestions", "pendingSuggestion", "planEditToken", "planMd", "prUrl", "repoPath", "repoSlug", "reporterId", "status", "statusMessageId", "threadId", "updatedAt", "workerId" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
