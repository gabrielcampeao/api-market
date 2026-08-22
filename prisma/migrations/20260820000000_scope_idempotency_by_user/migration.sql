-- Replace the route-only unique index with a composite scoped to the user as
-- well. These routes are authenticated and user-specific, so the cache must
-- not be shared across users.
DROP INDEX "idempotency_keys_key_route_key";

CREATE UNIQUE INDEX "idempotency_keys_key_route_user_id_key" ON "idempotency_keys"("key", "route", "user_id");
