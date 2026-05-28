-- CreateEnum
CREATE TYPE "GraphState" AS ENUM ('IMPORTING', 'AUDITING', 'READY');

-- CreateEnum
CREATE TYPE "ReviewTrigger" AS ENUM ('PREFLIGHT', 'SUBSCRIPTION', 'MANUAL', 'RE_AUDIT');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'TIMED_OUT', 'CRASHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PromptCategory" AS ENUM ('CORE', 'CUSTOM_ADMIN', 'ESCALATION', 'PATTERN_CHECK');

-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('DIFF_SUMMARY', 'DEPENDENCY_DIFF', 'LIFECYCLE_SCRIPT_CHANGES', 'CAPABILITY_DELTA', 'OBFUSCATION_INDICATORS', 'NATIVE_WASM_ADDITIONS', 'CHANGELOG_CONTEXT', 'REPOSITORY_SOURCE', 'SANDBOX_INSTALL_TRACE', 'NETWORK_EGRESS_TRACE', 'PI_SESSION_METADATA', 'PROMPT_VERSION', 'MODEL_VERSION', 'SCORES', 'REVIEWER_SUMMARY', 'STATIC_RULE_RESULTS', 'DECOMPILED_OUTPUT', 'OTHER');

CREATE TYPE "EvidenceStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'REDACTED');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('ALLOW', 'BLOCK', 'QUARANTINE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('AGENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "OverrideScope" AS ENUM ('SPECIFIC_VERSION', 'PACKAGE', 'PROJECT', 'GLOBAL');

-- CreateEnum
CREATE TYPE "ReAuditTrigger" AS ENUM ('PROMPT_CHANGE', 'MODEL_CHANGE', 'PATTERN_CHANGE', 'ADMIN_REQUEST', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LabelType" AS ENUM ('ADMIN_OVERRIDE', 'POST_HOC_RELABEL', 'INCIDENT_OUTCOME', 'EVALUATION_RESULT');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "graphState" "GraphState" NOT NULL DEFAULT 'IMPORTING',
    "registryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LockfileImport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "lockfilePath" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "packageCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LockfileImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageSubscription" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "registrySource" TEXT NOT NULL DEFAULT 'npm',
    "subscribedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackageSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpstreamMetadataSnapshot" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "registrySource" TEXT NOT NULL DEFAULT 'npm',
    "metadata" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpstreamMetadataSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageVersion" (
    "id" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "registrySource" TEXT NOT NULL DEFAULT 'npm',
    "tarballHash" TEXT NOT NULL,
    "tarballSize" INTEGER,
    "publishDate" TIMESTAMP(3),
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "repositoryUrl" TEXT,
    "homepageUrl" TEXT,
    "license" TEXT,
    "hasLifecycleScript" BOOLEAN NOT NULL DEFAULT false,
    "hasObfuscation" BOOLEAN NOT NULL DEFAULT false,
    "hasNativeBinary" BOOLEAN NOT NULL DEFAULT false,
    "hasWasm" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "predecessorId" TEXT,

    CONSTRAINT "PackageVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TarballArtifact" (
    "id" TEXT NOT NULL,
    "packageVersionId" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "fileCount" INTEGER,
    "totalSizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TarballArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportedPackageVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "packageVersionId" TEXT NOT NULL,
    "lockfileImportId" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportedPackageVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewJob" (
    "id" TEXT NOT NULL,
    "packageVersionId" TEXT NOT NULL,
    "auditContext" TEXT NOT NULL,
    "trigger" "ReviewTrigger" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "pgBossJobId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditRun" (
    "id" TEXT NOT NULL,
    "reviewJobId" TEXT NOT NULL,
    "containerId" TEXT,
    "containerName" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "timeoutAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "piSessionId" TEXT,
    "piRunId" TEXT,
    "rpcTokenHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptPack" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "category" "PromptCategory" NOT NULL,
    "content" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "apiKeyHash" TEXT,
    "temperature" DOUBLE PRECISION,
    "maxTokens" INTEGER,
    "isFallback" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceArtifact" (
    "id" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "artifactType" "EvidenceType" NOT NULL,
    "name" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "filePath" TEXT,
    "sizeBytes" INTEGER,
    "status" "EvidenceStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersedesEvidenceArtifactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "reviewJobId" TEXT NOT NULL,
    "packageVersionId" TEXT NOT NULL,
    "verdict" "Verdict" NOT NULL,
    "reasonSummary" TEXT NOT NULL,
    "predecessorVersion" TEXT,
    "predecessorHash" TEXT,
    "promptVersion" TEXT,
    "promptPackId" TEXT,
    "modelProfileId" TEXT,
    "scores" JSONB,
    "actorType" "ActorType" NOT NULL,
    "piSessionId" TEXT,
    "piRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Score" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "weight" DOUBLE PRECISION,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Score_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Override" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "adminIdentity" TEXT NOT NULL,
    "scope" "OverrideScope" NOT NULL,
    "targetVerdict" "Verdict" NOT NULL DEFAULT 'ALLOW',
    "reason" TEXT NOT NULL,
    "supersedesDecisionId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReAuditCampaign" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "triggerType" "ReAuditTrigger" NOT NULL,
    "promptPackId" TEXT,
    "modelProfileId" TEXT,
    "patternDefinition" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReAuditCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationLabel" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "evidenceArtifactId" TEXT,
    "labelType" "LabelType" NOT NULL,
    "labelValue" TEXT NOT NULL,
    "labelDescription" TEXT,
    "labeledBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_DecisionEvidence" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_DecisionEvidence_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_CampaignDecisions" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_CampaignDecisions_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PackageSubscription_projectId_packageName_registrySource_key" ON "PackageSubscription"("projectId", "packageName", "registrySource");

-- CreateIndex
CREATE INDEX "UpstreamMetadataSnapshot_subscriptionId_fetchedAt_idx" ON "UpstreamMetadataSnapshot"("subscriptionId", "fetchedAt");

-- CreateIndex
CREATE INDEX "PackageVersion_packageName_registrySource_idx" ON "PackageVersion"("packageName", "registrySource");

-- CreateIndex
CREATE INDEX "PackageVersion_tarballHash_idx" ON "PackageVersion"("tarballHash");

-- CreateIndex
CREATE UNIQUE INDEX "PackageVersion_packageName_version_registrySource_tarballHa_key" ON "PackageVersion"("packageName", "version", "registrySource", "tarballHash");

-- CreateIndex
CREATE INDEX "ImportedPackageVersion_projectId_idx" ON "ImportedPackageVersion"("projectId");

-- CreateIndex
CREATE INDEX "ImportedPackageVersion_packageVersionId_idx" ON "ImportedPackageVersion"("packageVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportedPackageVersion_projectId_packageVersionId_key" ON "ImportedPackageVersion"("projectId", "packageVersionId");

-- CreateIndex
CREATE INDEX "TarballArtifact_packageVersionId_idx" ON "TarballArtifact"("packageVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewJob_idempotencyKey_key" ON "ReviewJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ReviewJob_status_idx" ON "ReviewJob"("status");

-- CreateIndex
CREATE INDEX "EvidenceArtifact_supersedesEvidenceArtifactId_idx" ON "EvidenceArtifact"("supersedesEvidenceArtifactId");

-- CreateIndex
CREATE INDEX "ReviewJob_idempotencyKey_idx" ON "ReviewJob"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewJob_packageVersionId_auditContext_key" ON "ReviewJob"("packageVersionId", "auditContext");

-- CreateIndex
CREATE INDEX "AuditRun_reviewJobId_idx" ON "AuditRun"("reviewJobId");

-- CreateIndex
CREATE INDEX "AuditRun_piSessionId_idx" ON "AuditRun"("piSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptPack_hash_key" ON "PromptPack"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "PromptPack_name_version_key" ON "PromptPack"("name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ModelProfile_name_key" ON "ModelProfile"("name");

-- CreateIndex
CREATE INDEX "Decision_packageVersionId_verdict_idx" ON "Decision"("packageVersionId", "verdict");

-- CreateIndex
CREATE INDEX "Decision_reviewJobId_idx" ON "Decision"("reviewJobId");

-- CreateIndex
CREATE INDEX "Decision_promptPackId_idx" ON "Decision"("promptPackId");

-- CreateIndex
CREATE INDEX "Decision_modelProfileId_idx" ON "Decision"("modelProfileId");

-- CreateIndex
CREATE INDEX "Score_decisionId_idx" ON "Score"("decisionId");

-- CreateIndex
CREATE INDEX "Score_name_value_idx" ON "Score"("name", "value");

-- CreateIndex
CREATE INDEX "Override_decisionId_idx" ON "Override"("decisionId");

-- CreateIndex
CREATE INDEX "Override_adminIdentity_idx" ON "Override"("adminIdentity");

-- CreateIndex
CREATE INDEX "EvaluationLabel_decisionId_idx" ON "EvaluationLabel"("decisionId");

-- CreateIndex
CREATE INDEX "EvaluationLabel_labelType_labelValue_idx" ON "EvaluationLabel"("labelType", "labelValue");

-- CreateIndex
CREATE INDEX "_DecisionEvidence_B_index" ON "_DecisionEvidence"("B");

-- CreateIndex
CREATE INDEX "_CampaignDecisions_B_index" ON "_CampaignDecisions"("B");

-- AddForeignKey
ALTER TABLE "LockfileImport" ADD CONSTRAINT "LockfileImport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageSubscription" ADD CONSTRAINT "PackageSubscription_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpstreamMetadataSnapshot" ADD CONSTRAINT "UpstreamMetadataSnapshot_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "PackageSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageVersion" ADD CONSTRAINT "PackageVersion_predecessorId_fkey" FOREIGN KEY ("predecessorId") REFERENCES "PackageVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TarballArtifact" ADD CONSTRAINT "TarballArtifact_packageVersionId_fkey" FOREIGN KEY ("packageVersionId") REFERENCES "PackageVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedPackageVersion" ADD CONSTRAINT "ImportedPackageVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedPackageVersion" ADD CONSTRAINT "ImportedPackageVersion_packageVersionId_fkey" FOREIGN KEY ("packageVersionId") REFERENCES "PackageVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewJob" ADD CONSTRAINT "ReviewJob_packageVersionId_fkey" FOREIGN KEY ("packageVersionId") REFERENCES "PackageVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRun" ADD CONSTRAINT "AuditRun_reviewJobId_fkey" FOREIGN KEY ("reviewJobId") REFERENCES "ReviewJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceArtifact" ADD CONSTRAINT "EvidenceArtifact_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "AuditRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceArtifact" ADD CONSTRAINT "EvidenceArtifact_supersedesEvidenceArtifactId_fkey" FOREIGN KEY ("supersedesEvidenceArtifactId") REFERENCES "EvidenceArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_reviewJobId_fkey" FOREIGN KEY ("reviewJobId") REFERENCES "ReviewJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_packageVersionId_fkey" FOREIGN KEY ("packageVersionId") REFERENCES "PackageVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_promptPackId_fkey" FOREIGN KEY ("promptPackId") REFERENCES "PromptPack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_modelProfileId_fkey" FOREIGN KEY ("modelProfileId") REFERENCES "ModelProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Override" ADD CONSTRAINT "Override_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReAuditCampaign" ADD CONSTRAINT "ReAuditCampaign_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationLabel" ADD CONSTRAINT "EvaluationLabel_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationLabel" ADD CONSTRAINT "EvaluationLabel_evidenceArtifactId_fkey" FOREIGN KEY ("evidenceArtifactId") REFERENCES "EvidenceArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DecisionEvidence" ADD CONSTRAINT "_DecisionEvidence_A_fkey" FOREIGN KEY ("A") REFERENCES "Decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DecisionEvidence" ADD CONSTRAINT "_DecisionEvidence_B_fkey" FOREIGN KEY ("B") REFERENCES "EvidenceArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CampaignDecisions" ADD CONSTRAINT "_CampaignDecisions_A_fkey" FOREIGN KEY ("A") REFERENCES "Decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CampaignDecisions" ADD CONSTRAINT "_CampaignDecisions_B_fkey" FOREIGN KEY ("B") REFERENCES "ReAuditCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
