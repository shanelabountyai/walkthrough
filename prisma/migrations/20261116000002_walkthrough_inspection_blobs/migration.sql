-- Review fix 2026-11-16 (D-40): an inspection reaches a blob only through a link written when bytes uploaded through
-- that inspection matched it. StoredBlob stays shared per org (dedupe).

-- CreateTable
CREATE TABLE "InspectionBlob" (
    "orgId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "blobHash" TEXT NOT NULL,
    "received" INTEGER NOT NULL DEFAULT 0,
    "linked" BOOLEAN NOT NULL DEFAULT false,
    "linkedAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionBlob_pkey" PRIMARY KEY ("inspectionId","blobHash")
);

-- CreateIndex
CREATE INDEX "InspectionBlob_orgId_blobHash_idx" ON "InspectionBlob"("orgId", "blobHash");

-- AddForeignKey
ALTER TABLE "InspectionBlob" ADD CONSTRAINT "InspectionBlob_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionBlob" ADD CONSTRAINT "InspectionBlob_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (Phase 4 was never deployed, D-30; this only keeps local data readable): a complete blob stays reachable
-- through the inspections whose log names it in an answer written by the user who uploaded it.
INSERT INTO "InspectionBlob" ("orgId", "inspectionId", "blobHash", "received", "linked", "linkedAt", "createdById")
SELECT DISTINCT b."orgId", o."inspectionId", b.hash, b.size, true, b."completedAt", b."createdById"
FROM "StoredBlob" b
JOIN "InspectionOp" o ON o."orgId" = b."orgId" AND o.kind = 'set' AND o."userId" = b."createdById"
  AND (o.value = to_jsonb(b.hash) OR o.value @> jsonb_build_array(b.hash) OR o.value ->> 'image' = b.hash)
WHERE b.complete AND b."createdById" IS NOT NULL
ON CONFLICT DO NOTHING;
