-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "supersedesDecisionId" TEXT;

-- CreateIndex
CREATE INDEX "Decision_supersedesDecisionId_idx" ON "Decision"("supersedesDecisionId");

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_supersedesDecisionId_fkey" FOREIGN KEY ("supersedesDecisionId") REFERENCES "Decision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
