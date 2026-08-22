-- Drop the old key-only unique constraint and replace it with a composite
-- (key, route) constraint. A client-supplied Idempotency-Key header is only
-- meant to be unique per resource path (e.g. per order id) -- keeping it
-- globally unique meant reusing the same key across two different orders
-- silently replayed the first order's cached response for the second one.
DROP INDEX "idempotency_keys_key_key";

CREATE UNIQUE INDEX "idempotency_keys_key_route_key" ON "idempotency_keys"("key", "route");
