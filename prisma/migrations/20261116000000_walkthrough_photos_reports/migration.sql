-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "completedAt" TIMESTAMPTZ(6),
ADD COLUMN     "completedById" UUID;

-- CreateTable
CREATE TABLE "StoredBlob" (
    "orgId" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL,
    "received" INTEGER NOT NULL DEFAULT 0,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "StoredBlob_pkey" PRIMARY KEY ("orgId","hash")
);

-- CreateTable
CREATE TABLE "InspectionReport" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "opSeq" INTEGER NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InspectionReport_orgId_idx" ON "InspectionReport"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionReport_inspectionId_number_key" ON "InspectionReport"("inspectionId", "number");

-- AddForeignKey
ALTER TABLE "StoredBlob" ADD CONSTRAINT "StoredBlob_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionReport" ADD CONSTRAINT "InspectionReport_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionReport" ADD CONSTRAINT "InspectionReport_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A generated report never changes (a later change is report n+1). DELETE stays possible so deleting an org or an
-- inspection cascades, like the Phase 2 triggers.
CREATE TRIGGER "InspectionReport_append_only"
  BEFORE UPDATE ON "InspectionReport"
  FOR EACH ROW EXECUTE FUNCTION walkthrough_refuse_update();
