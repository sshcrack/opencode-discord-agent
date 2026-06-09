-- CreateTable
CREATE TABLE "Repository" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slug" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ReportThread" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "threadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "repoSlug" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Job" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "threadId" TEXT NOT NULL,
    "repoSlug" TEXT NOT NULL,
    "repoPath" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "workerId" TEXT,
    "planMd" TEXT,
    "opencodeSessionId" TEXT,
    "issueNumber" INTEGER,
    "prUrl" TEXT,
    "autoMode" BOOLEAN NOT NULL DEFAULT false,
    "pendingSuggestion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Job_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ReportThread" ("threadId") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Repository_slug_key" ON "Repository"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ReportThread_threadId_key" ON "ReportThread"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"("key");
