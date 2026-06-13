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
    "buildSessionId" TEXT,
    "issueNumber" INTEGER,
    "mergedAt" DATETIME,
    "prUrl" TEXT,
    "branch" TEXT,
    "parentJobId" INTEGER,
    "autoMode" BOOLEAN NOT NULL DEFAULT false,
    "quickMode" BOOLEAN NOT NULL DEFAULT false,
    "hardwork" BOOLEAN NOT NULL DEFAULT false,
    "parallelPlanCount" INTEGER NOT NULL DEFAULT 3,
    "hardworkPlans" TEXT,
    "selectedPlanIndex" INTEGER,
    "pendingSuggestion" TEXT,
    "planEditToken" TEXT,
    "statusMessageId" TEXT,
    "pendingQuestions" TEXT,
    "pendingQuestionIndex" INTEGER,
    "pendingAnswers" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Job_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ReportThread" ("threadId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Job_parentJobId_fkey" FOREIGN KEY ("parentJobId") REFERENCES "Job" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Job" ("autoMode", "branch", "buildSessionId", "context", "createdAt", "id", "issueNumber", "kind", "mergedAt", "opencodeSessionId", "parentJobId", "pendingAnswers", "pendingQuestionIndex", "pendingQuestions", "pendingSuggestion", "planEditToken", "planMd", "prUrl", "quickMode", "repoPath", "repoSlug", "reporterId", "status", "statusMessageId", "threadId", "updatedAt", "workerId") SELECT "autoMode", "branch", "buildSessionId", "context", "createdAt", "id", "issueNumber", "kind", "mergedAt", "opencodeSessionId", "parentJobId", "pendingAnswers", "pendingQuestionIndex", "pendingQuestions", "pendingSuggestion", "planEditToken", "planMd", "prUrl", "quickMode", "repoPath", "repoSlug", "reporterId", "status", "statusMessageId", "threadId", "updatedAt", "workerId" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
