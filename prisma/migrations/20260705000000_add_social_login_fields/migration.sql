ALTER TABLE "User" ADD COLUMN "provider"   TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "User" ADD COLUMN "providerId" TEXT;
ALTER TABLE "User" ADD COLUMN "email"      TEXT;
ALTER TABLE "User" ALTER COLUMN "role" DROP NOT NULL;

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_provider_providerId_key" ON "User"("provider", "providerId");
