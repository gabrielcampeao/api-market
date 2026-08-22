/*
  Warnings:

  - Added the required column `request_hash` to the `idempotency_keys` table without a default value. This is not possible if the table is not empty.

*/

-- idempotency_keys is a pure cache with a 24h TTL (see IdempotencyService):
-- every row either already has a cached response or is an in-flight
-- placeholder, and losing either is equivalent to that key naturally
-- expiring — the worst case is a client's retry re-executes instead of
-- getting a cached hit, which is the same thing that happens after TTL
-- anyway. So the safe way to add a NOT NULL column here is to just clear
-- the cache, not backfill a fake hash that would let old rows silently skip
-- the payload-mismatch check this column exists for.
DELETE FROM "idempotency_keys";

-- AlterTable
ALTER TABLE "idempotency_keys" ADD COLUMN     "request_hash" TEXT NOT NULL;
