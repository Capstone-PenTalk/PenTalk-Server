-- CreateTable
CREATE TABLE "QuizAnswer" (
    "id"              TEXT         NOT NULL,
    "sessionId"       TEXT         NOT NULL,
    "questionId"      TEXT         NOT NULL,
    "userId"          TEXT         NOT NULL,
    "submittedAnswer" TEXT         NOT NULL,
    "isCorrect"       BOOLEAN      NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizAnswer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QuizAnswer_questionId_fkey"
        FOREIGN KEY ("questionId") REFERENCES "QuizQuestion"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "QuizAnswer_sessionId_questionId_userId_key"
    ON "QuizAnswer"("sessionId", "questionId", "userId");

-- CreateIndex
CREATE INDEX "QuizAnswer_sessionId_questionId_idx"
    ON "QuizAnswer"("sessionId", "questionId");
