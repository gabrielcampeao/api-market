import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent';

/**
 * Mark a route handler as idempotency-eligible.
 * The client must send the `Idempotency-Key` header for the protection to activate.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);
