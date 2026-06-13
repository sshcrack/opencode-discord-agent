-- AlterTable
ALTER TABLE "Job" ADD COLUMN "worktreePath" TEXT;

-- CreateTable
CREATE TABLE "PlanRevision" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" INTEGER NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "planMd" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanRevision_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanRevision_jobId_revisionNumber_key" ON "PlanRevision"("jobId", "revisionNumber");
