import { RedisThrottlerStorage } from './redis-throttler.storage';

describe('RedisThrottlerStorage', () => {
  it('increments and reports not-blocked under normal conditions', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
      pttl: jest.fn().mockResolvedValue(5000),
      eval: jest.fn().mockResolvedValue(1),
    };
    const storage = new RedisThrottlerStorage(redis as never);

    const result = await storage.increment('ip-1', 60_000, 10, 60_000, 'default');

    expect(result.isBlocked).toBe(false);
    expect(result.totalHits).toBe(1);
  });

  it('reports blocked once the limit is exceeded', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      pttl: jest.fn().mockResolvedValue(60_000),
      eval: jest.fn().mockResolvedValue(11),
    };
    const storage = new RedisThrottlerStorage(redis as never);

    const result = await storage.increment('ip-1', 60_000, 10, 60_000, 'default');

    expect(result.isBlocked).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining('throttle:block:'), '1', 'PX', 60_000);
  });

  // The chaos scenario: Redis is reachable at boot (so this class got
  // selected over the in-memory fallback) but drops mid-run. Without this
  // guarantee, every request through the global ThrottlerGuard would 500 —
  // a rate-limiter outage taking down the whole API is a worse failure mode
  // than temporarily unlimited traffic.
  it('fails open (allows the request) if Redis becomes unreachable mid-run', async () => {
    const redis = {
      get: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
      set: jest.fn(),
      pttl: jest.fn(),
      eval: jest.fn(),
    };
    const storage = new RedisThrottlerStorage(redis as never);

    const result = await storage.increment('ip-1', 60_000, 10, 60_000, 'default');

    expect(result.isBlocked).toBe(false);
  });

  it('fails open if the increment script itself errors', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
      pttl: jest.fn(),
      eval: jest.fn().mockRejectedValue(new Error('READONLY You can\'t write against a read only replica.')),
    };
    const storage = new RedisThrottlerStorage(redis as never);

    const result = await storage.increment('ip-1', 60_000, 10, 60_000, 'default');

    expect(result.isBlocked).toBe(false);
  });
});
