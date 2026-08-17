-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Market" AS ENUM ('TH', 'US');

-- CreateEnum
CREATE TYPE "PeriodType" AS ENUM ('ANNUAL', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "RefreshStatus" AS ENUM ('SUCCESS', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock" (
    "id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "market" "Market" NOT NULL,
    "exchange" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sector" TEXT,
    "industry" TEXT,
    "currency" TEXT,
    "description" TEXT,
    "price" DOUBLE PRECISION,
    "priceChangePct1d" DOUBLE PRECISION,
    "marketCap" DOUBLE PRECISION,
    "marketCapUsd" DOUBLE PRECISION,
    "fxRateToUsd" DOUBLE PRECISION,
    "sharesOutstanding" DOUBLE PRECISION,
    "fiftyTwoWeekHigh" DOUBLE PRECISION,
    "fiftyTwoWeekLow" DOUBLE PRECISION,
    "beta" DOUBLE PRECISION,
    "epsTtm" DOUBLE PRECISION,
    "bookValuePerShare" DOUBLE PRECISION,
    "revenueTtm" DOUBLE PRECISION,
    "totalCash" DOUBLE PRECISION,
    "peRatio" DOUBLE PRECISION,
    "forwardPe" DOUBLE PRECISION,
    "pbRatio" DOUBLE PRECISION,
    "psRatio" DOUBLE PRECISION,
    "evToEbitda" DOUBLE PRECISION,
    "estEarningsGrowth" DOUBLE PRECISION,
    "estRevenueGrowth" DOUBLE PRECISION,
    "analystTargetPrice" DOUBLE PRECISION,
    "recommendationMean" DOUBLE PRECISION,
    "numAnalystOpinions" INTEGER,
    "roe" DOUBLE PRECISION,
    "roa" DOUBLE PRECISION,
    "grossMargin" DOUBLE PRECISION,
    "operatingMargin" DOUBLE PRECISION,
    "netMargin" DOUBLE PRECISION,
    "debtToEquity" DOUBLE PRECISION,
    "currentRatio" DOUBLE PRECISION,
    "quickRatio" DOUBLE PRECISION,
    "interestCoverage" DOUBLE PRECISION,
    "dividendYield" DOUBLE PRECISION,
    "payoutRatio" DOUBLE PRECISION,
    "heldPercentInsiders" DOUBLE PRECISION,
    "heldPercentInstitutions" DOUBLE PRECISION,
    "floatShares" DOUBLE PRECISION,
    "latestOverallScore" DOUBLE PRECISION,
    "latestValueScore" DOUBLE PRECISION,
    "latestFutureScore" DOUBLE PRECISION,
    "latestPastScore" DOUBLE PRECISION,
    "latestHealthScore" DOUBLE PRECISION,
    "latestDividendScore" DOUBLE PRECISION,
    "latestMomentumScore" DOUBLE PRECISION,
    "latestScoreDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialHistory" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodType" "PeriodType" NOT NULL,
    "fiscalDateEnding" TIMESTAMP(3) NOT NULL,
    "revenue" DOUBLE PRECISION,
    "netIncome" DOUBLE PRECISION,
    "eps" DOUBLE PRECISION,
    "freeCashFlow" DOUBLE PRECISION,
    "totalDebt" DOUBLE PRECISION,
    "totalEquity" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreSnapshot" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "valueScore" DOUBLE PRECISION,
    "futureScore" DOUBLE PRECISION,
    "pastScore" DOUBLE PRECISION,
    "healthScore" DOUBLE PRECISION,
    "dividendScore" DOUBLE PRECISION,
    "momentumScore" DOUBLE PRECISION,
    "overallScore" DOUBLE PRECISION,
    "rawMetricsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "notes" TEXT,
    "targetPrice" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshLog" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "RefreshStatus" NOT NULL,
    "tickersProcessed" INTEGER NOT NULL DEFAULT 0,
    "tickersFailed" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,

    CONSTRAINT "RefreshLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ticker" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeepReport" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeepReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_ticker_key" ON "Stock"("ticker");

-- CreateIndex
CREATE INDEX "Stock_market_idx" ON "Stock"("market");

-- CreateIndex
CREATE INDEX "Stock_sector_idx" ON "Stock"("sector");

-- CreateIndex
CREATE INDEX "Stock_isActive_idx" ON "Stock"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialHistory_stockId_period_periodType_key" ON "FinancialHistory"("stockId", "period", "periodType");

-- CreateIndex
CREATE INDEX "PriceHistory_date_idx" ON "PriceHistory"("date");

-- CreateIndex
CREATE UNIQUE INDEX "PriceHistory_stockId_date_key" ON "PriceHistory"("stockId", "date");

-- CreateIndex
CREATE INDEX "ScoreSnapshot_date_idx" ON "ScoreSnapshot"("date");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreSnapshot_stockId_date_key" ON "ScoreSnapshot"("stockId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_userId_stockId_key" ON "WatchlistItem"("userId", "stockId");

-- CreateIndex
CREATE INDEX "Note_userId_ticker_idx" ON "Note"("userId", "ticker");

-- CreateIndex
CREATE UNIQUE INDEX "Note_userId_sourcePath_key" ON "Note"("userId", "sourcePath");

-- CreateIndex
CREATE INDEX "DeepReport_stockId_userId_idx" ON "DeepReport"("stockId", "userId");

-- AddForeignKey
ALTER TABLE "FinancialHistory" ADD CONSTRAINT "FinancialHistory_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreSnapshot" ADD CONSTRAINT "ScoreSnapshot_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeepReport" ADD CONSTRAINT "DeepReport_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeepReport" ADD CONSTRAINT "DeepReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

