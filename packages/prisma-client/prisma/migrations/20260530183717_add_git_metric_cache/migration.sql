-- CreateTable
CREATE TABLE IF NOT EXISTS "GitMetricCache" (
    "id" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "packageVersion" TEXT NOT NULL,
    "metricType" TEXT NOT NULL,
    "timeseries" JSONB NOT NULL,
    "repoUrl" TEXT,
    "commitCount" INTEGER,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitMetricCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "GitMetricCache_packageName_packageVersion_metricType_key"
    ON "GitMetricCache"("packageName", "packageVersion", "metricType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GitMetricCache_packageName_packageVersion_idx"
    ON "GitMetricCache"("packageName", "packageVersion");
