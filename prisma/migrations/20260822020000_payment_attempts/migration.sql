-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'ERROR');

-- AlterTable: provider_idempotency_key is added NOT NULL + UNIQUE, but
-- payments (unlike idempotency_keys) is real financial data — it can't be
-- wiped like a cache table if this ever runs against a non-empty table.
-- Add nullable, backfill each existing row with a distinct value, then
-- enforce NOT NULL. md5(random()::text || ...) needs no Postgres extension
-- (gen_random_uuid() would require pgcrypto to be enabled first).
ALTER TABLE "payments" ADD COLUMN     "provider_idempotency_key" TEXT;

UPDATE "payments"
SET "provider_idempotency_key" = md5(random()::text || clock_timestamp()::text || id::text)
WHERE "provider_idempotency_key" IS NULL;

ALTER TABLE "payments" ALTER COLUMN "provider_idempotency_key" SET NOT NULL;

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(10,2) NOT NULL,
    "failure_code" TEXT,
    "failure_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_attempts_payment_id_idx" ON "payment_attempts"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_idempotency_key_key" ON "payments"("provider_idempotency_key");

-- CHECK: attempt amount mirrors the same non-negative-money invariant as
-- every other money column in this schema.
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_amount_nonnegative" CHECK ("amount" >= 0);

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
