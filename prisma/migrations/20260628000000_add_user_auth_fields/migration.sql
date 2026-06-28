ALTER TABLE "User" ADD COLUMN "loginId"      TEXT;
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
CREATE UNIQUE INDEX "User_loginId_key" ON "User"("loginId");
