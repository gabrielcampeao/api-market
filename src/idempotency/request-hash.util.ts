import { createHash } from 'crypto';

// Plain `JSON.stringify` is sensitive to key order, so two requests with the
// same logical body (e.g. `{a:1,b:2}` vs `{b:2,a:1}`) would hash differently
// and get flagged as a payload mismatch. Sorting keys recursively before
// stringifying makes the hash depend only on content, not property order.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function hashRequestBody(body: unknown): string {
  const json = JSON.stringify(canonicalize(body ?? {}));
  return createHash('sha256').update(json).digest('hex');
}
