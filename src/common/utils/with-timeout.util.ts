// A hung provider call (network stall, not an error) would otherwise hold
// the HTTP request open for however long the underlying client's own
// default timeout is — 80s for the Stripe SDK, unbounded for a naive fake.
// Racing against a local timer bounds that regardless of which provider is
// plugged in, and produces the same "unknown outcome" shape a thrown error
// already does, so callers don't need a separate code path for it.
export class TimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
