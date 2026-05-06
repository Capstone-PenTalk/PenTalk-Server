-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('PENDING', 'ANSWERED');

-- CreateTable
CREATE TABLE "Question" (
    "id"        TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "content"   TEXT NOT NULL,
    "status"    "QuestionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Question_sessionId_createdAt_idx" ON "Question"("sessionId", "createdAt");
