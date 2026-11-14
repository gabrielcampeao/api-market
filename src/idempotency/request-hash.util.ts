import { createHash } from 'crypto';
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
