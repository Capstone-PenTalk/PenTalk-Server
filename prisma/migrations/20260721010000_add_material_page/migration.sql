-- CreateTable
CREATE TABLE "MaterialPage" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "imageKey" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaterialPage_materialId_idx" ON "MaterialPage"("materialId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialPage_materialId_pageNumber_key" ON "MaterialPage"("materialId", "pageNumber");

-- AddForeignKey
ALTER TABLE "MaterialPage" ADD CONSTRAINT "MaterialPage_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;
