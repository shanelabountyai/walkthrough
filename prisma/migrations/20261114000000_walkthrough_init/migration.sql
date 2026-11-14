-- Walkthrough Phase 2 (docs/walkthrough/PHASE2_PLAN.md): templates, inspections, the server op log, device bindings.
-- CreateTable
CREATE TABLE "ChecklistTemplate" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChecklistTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateVersion" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inspection" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "templateVersionId" UUID NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "assigneeId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "clock" INTEGER NOT NULL DEFAULT 0,
    "opSeq" INTEGER NOT NULL DEFAULT 0,
    "conflictPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionOp" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "opId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "lamport" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT,
    "value" JSONB,
    "prev" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "templateId" UUID,
    "templateVersion" INTEGER NOT NULL,
    "userId" UUID,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionOp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncDevice" (
    "orgId" UUID NOT NULL,
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncDevice_pkey" PRIMARY KEY ("orgId","id")
);

-- CreateIndex
CREATE INDEX "ChecklistTemplate_orgId_idx" ON "ChecklistTemplate"("orgId");

-- CreateIndex
CREATE INDEX "TemplateVersion_orgId_idx" ON "TemplateVersion"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateVersion_templateId_version_key" ON "TemplateVersion"("templateId", "version");

-- CreateIndex
CREATE INDEX "Inspection_orgId_assigneeId_idx" ON "Inspection"("orgId", "assigneeId");

-- CreateIndex
CREATE INDEX "InspectionOp_orgId_idx" ON "InspectionOp"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionOp_inspectionId_opId_key" ON "InspectionOp"("inspectionId", "opId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionOp_inspectionId_seq_key" ON "InspectionOp"("inspectionId", "seq");

-- AddForeignKey
ALTER TABLE "ChecklistTemplate" ADD CONSTRAINT "ChecklistTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ChecklistTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ChecklistTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "TemplateVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionOp" ADD CONSTRAINT "InspectionOp_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionOp" ADD CONSTRAINT "InspectionOp_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncDevice" ADD CONSTRAINT "SyncDevice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- WT-04: a published template version never changes (a change is version n+1). WT-01: an acknowledged op is never
-- rewritten. Both refuse UPDATE only: DELETE stays possible so deleting an org (or an inspection) cascades. TRUNCATE
-- is left alone (row triggers do not fire on it), so tests can still empty the tables.
CREATE FUNCTION walkthrough_refuse_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "TemplateVersion_immutable"
  BEFORE UPDATE ON "TemplateVersion"
  FOR EACH ROW EXECUTE FUNCTION walkthrough_refuse_update();

CREATE TRIGGER "InspectionOp_append_only"
  BEFORE UPDATE ON "InspectionOp"
  FOR EACH ROW EXECUTE FUNCTION walkthrough_refuse_update();
