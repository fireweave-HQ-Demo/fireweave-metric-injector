-- CreateEnum
CREATE TYPE "role" AS ENUM ('admin', 'user');

-- CreateEnum
CREATE TYPE "vendor_type" AS ENUM ('openobserve', 'datadog', 'sentry');

-- CreateEnum
CREATE TYPE "credential_kind" AS ENUM ('api_key', 'token', 'email', 'dsn_key');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('scheduled', 'active', 'paused', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "fanout_mode" AS ENUM ('replicate', 'split');

-- CreateEnum
CREATE TYPE "metric_type" AS ENUM ('counter', 'gauge', 'histogram');

-- CreateEnum
CREATE TYPE "metric_category" AS ENUM ('success', 'error', 'custom', 'dependent');

-- CreateEnum
CREATE TYPE "batch_status" AS ENUM ('in_flight', 'completed', 'abandoned');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('pending', 'delivered', 'dead');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "role" NOT NULL DEFAULT 'user',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "chain_id" UUID NOT NULL,
    "parent_id" UUID,
    "replaced_by_id" UUID,
    "token_hash" TEXT NOT NULL,
    "user_agent_hash" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "vendor_type" "vendor_type" NOT NULL,
    "label" TEXT NOT NULL,
    "credentials_cipher" BYTEA NOT NULL,
    "credential_hint" TEXT NOT NULL,
    "credential_kind" "credential_kind" NOT NULL,
    "validated_at" TIMESTAMPTZ(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vendor_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_jobs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "job_status" NOT NULL,
    "fanout_mode" "fanout_mode" NOT NULL DEFAULT 'replicate',
    "timezone" TEXT NOT NULL,
    "virtual_user_count" INTEGER NOT NULL,
    "peak_rate_per_second" DOUBLE PRECISION NOT NULL,
    "success_probability" DOUBLE PRECISION NOT NULL,
    "error_probability" DOUBLE PRECISION NOT NULL,
    "tick_interval_ms" INTEGER NOT NULL DEFAULT 1000,
    "start_time" TIMESTAMPTZ(3) NOT NULL,
    "end_time" TIMESTAMPTZ(3),
    "last_simulated_at" TIMESTAMPTZ(3),
    "consecutive_lag_ticks" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ingestion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_vendor_accounts" (
    "job_id" UUID NOT NULL,
    "vendor_account_id" UUID NOT NULL,

    CONSTRAINT "job_vendor_accounts_pkey" PRIMARY KEY ("job_id","vendor_account_id")
);

-- CreateTable
CREATE TABLE "metric_definitions" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "metric_type" NOT NULL,
    "category" "metric_category" NOT NULL,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "depends_on" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "formula" TEXT,
    "eval_order" INTEGER NOT NULL,
    "success_probability" DOUBLE PRECISION,
    "error_probability" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "metric_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_batches" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "window_end" TIMESTAMPTZ(3) NOT NULL,
    "status" "batch_status" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "ingestion_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_deliveries" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "vendor_account_id" UUID NOT NULL,
    "status" "delivery_status" NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_failures" (
    "id" UUID NOT NULL,
    "job_id" UUID,
    "vendor_account_id" UUID,
    "delivery_id" UUID,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_id_key" ON "refresh_tokens"("replaced_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_chain_id_idx" ON "refresh_tokens"("chain_id");

-- CreateIndex
CREATE INDEX "vendor_accounts_user_id_idx" ON "vendor_accounts"("user_id");

-- CreateIndex
CREATE INDEX "ingestion_jobs_user_id_created_at_idx" ON "ingestion_jobs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "metric_definitions_job_id_eval_order_idx" ON "metric_definitions"("job_id", "eval_order");

-- CreateIndex
CREATE INDEX "ingestion_batches_job_id_created_at_idx" ON "ingestion_batches"("job_id", "created_at");

-- CreateIndex
CREATE INDEX "ingestion_batches_status_created_at_idx" ON "ingestion_batches"("status", "created_at");

-- CreateIndex
CREATE INDEX "ingestion_deliveries_batch_id_idx" ON "ingestion_deliveries"("batch_id");

-- CreateIndex
CREATE INDEX "ingestion_deliveries_vendor_account_id_idx" ON "ingestion_deliveries"("vendor_account_id");

-- CreateIndex
CREATE INDEX "ingestion_failures_job_id_created_at_idx" ON "ingestion_failures"("job_id", "created_at");

-- CreateIndex
CREATE INDEX "ingestion_failures_created_at_idx" ON "ingestion_failures"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_accounts" ADD CONSTRAINT "vendor_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_vendor_accounts" ADD CONSTRAINT "job_vendor_accounts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ingestion_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_vendor_accounts" ADD CONSTRAINT "job_vendor_accounts_vendor_account_id_fkey" FOREIGN KEY ("vendor_account_id") REFERENCES "vendor_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ingestion_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ingestion_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_deliveries" ADD CONSTRAINT "ingestion_deliveries_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "ingestion_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_deliveries" ADD CONSTRAINT "ingestion_deliveries_vendor_account_id_fkey" FOREIGN KEY ("vendor_account_id") REFERENCES "vendor_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_failures" ADD CONSTRAINT "ingestion_failures_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ingestion_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_failures" ADD CONSTRAINT "ingestion_failures_vendor_account_id_fkey" FOREIGN KEY ("vendor_account_id") REFERENCES "vendor_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_failures" ADD CONSTRAINT "ingestion_failures_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "ingestion_deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
