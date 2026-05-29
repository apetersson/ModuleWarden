-- Create AuditPipeline and AuditPipelineStep models for DAG-linearised audit ordering

-- Create enum types
CREATE TYPE "AuditPipelineStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');
CREATE TYPE "AuditStepStatus" AS ENUM ('PENDING', 'READY', 'RUNNING', 'ALLOWED', 'BLOCKED', 'QUARANTINED', 'FAILED');

-- Create AuditPipeline table
CREATE TABLE "AuditPipeline" (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "rootPackageName" TEXT NOT NULL,
    "rootPackageVersion" TEXT NOT NULL,
    "tarballHash" TEXT NOT NULL,
    "totalSteps" INTEGER NOT NULL,
    status "AuditPipelineStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create AuditPipelineStep table
CREATE TABLE "AuditPipelineStep" (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "pipelineId" UUID NOT NULL REFERENCES "AuditPipeline"(id),
    "packageName" TEXT NOT NULL,
    "packageVersion" TEXT NOT NULL,
    "tarballHash" TEXT NOT NULL,
    depth INTEGER NOT NULL,
    "dependsOn" TEXT NOT NULL DEFAULT '',
    "linearOrder" INTEGER NOT NULL,
    status "AuditStepStatus" NOT NULL DEFAULT 'PENDING',
    "reviewJobId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_audit_pipeline_step_pipeline_order ON "AuditPipelineStep"("pipelineId", "linearOrder");
CREATE INDEX IF NOT EXISTS idx_audit_pipeline_step_pipeline_status ON "AuditPipelineStep"("pipelineId", status);
