-- AlterTable
ALTER TABLE "EvidenceArtifact" ADD COLUMN     "schemaVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ModelProfile" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT false;
