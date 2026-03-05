-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'CLOSING', 'ARCHIVED', 'FAILED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "materialId" TEXT,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "drawingPath" TEXT,
    "closedAt" TIMESTAMP(3),
    "endAttempts" INTEGER NOT NULL DEFAULT 0,
    "endError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_classId_createdAt_idx" ON "Session"("classId", "createdAt");

-- CreateIndex
CREATE INDEX "Session_status_idx" ON "Session"("status");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;
