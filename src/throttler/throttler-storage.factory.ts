import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisThrottlerStorage, ThrottlerRedisLike } from './redis-throttler.storage';

class InMemoryThrottlerStorage implements ThrottlerStorage {
  private readonly store = new Map<string, { hits: number; expiresAt: number }>();

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    const storageKey = `${throttlerName}:${key}`;
    const current = this.store.get(storageKey);

    if (!current || current.expiresAt <= now) {
      this.store.set(storageKey, { hits: 1, expiresAt: now + ttl });
      return {
        totalHits: 1,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }

    const hits = current.hits + 1;
    if (hits > limit) {
      this.store.set(storageKey, {
        hits,
        expiresAt: now + blockDuration,
      });
      return {
        totalHits: hits,
        timeToExpire: 0,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockDuration / 1000),
      };
    }

    current.hits = hits;
    return {
      totalHits: hits,
      timeToExpire: Math.max(Math.ceil((current.expiresAt - now) / 1000), 0),
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}

export async function createThrottlerStorage(
  redis: ThrottlerRedisLike,
): Promise<ThrottlerStorage> {
  try {
    await Promise.race([
      redis.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('redis ping timeout')), 1000),
      ),
    ]);
    return new RedisThrottlerStorage(redis);
  } catch {
    // Redis unavailable: fall back to an in-memory limiter so the API still boots.
    return new InMemoryThrottlerStorage();
  }
}
