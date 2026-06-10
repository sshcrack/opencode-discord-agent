-- AlterTable
ALTER TABLE "Job" ADD COLUMN "pendingAnswers" TEXT;
ALTER TABLE "Job" ADD COLUMN "pendingQuestionIndex" INTEGER;
ALTER TABLE "Job" ADD COLUMN "pendingQuestions" TEXT;
