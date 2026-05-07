-- CreateTable
CREATE TABLE "QuizQuestion" (
    "id"        TEXT         NOT NULL,
    "sessionId" TEXT         NOT NULL,
    "question"  TEXT         NOT NULL,
    "answer"    TEXT         NOT NULL,
    "order"     INTEGER      NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizQuestion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QuizQuestion_sessionId_fkey"
        FOREIGN KEY ("sessionId") REFERENCES "Session"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "QuizQuestion_sessionId_order_key" ON "QuizQuestion"("sessionId", "order");

-- CreateIndex
CREATE INDEX "QuizQuestion_sessionId_idx" ON "QuizQuestion"("sessionId");
