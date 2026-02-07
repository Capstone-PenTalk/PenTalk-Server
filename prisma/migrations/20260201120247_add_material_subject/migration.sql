-- CreateTable
CREATE TABLE "MaterialSubject" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "materialId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,

    CONSTRAINT "MaterialSubject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaterialSubject_subjectId_materialId_idx" ON "MaterialSubject"("subjectId", "materialId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialSubject_materialId_subjectId_key" ON "MaterialSubject"("materialId", "subjectId");

-- AddForeignKey
ALTER TABLE "MaterialSubject" ADD CONSTRAINT "MaterialSubject_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialSubject" ADD CONSTRAINT "MaterialSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
