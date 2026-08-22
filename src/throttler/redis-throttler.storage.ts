import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

// The one Redis client type shared with throttler-storage.factory.ts — that
// factory needs `ping` (to health-check before committing to Redis-backed
// storage) and this class needs the rest (to actually implement it), so the
// shape lives here rather than being split into two near-identical
// structural types.
export interface ThrottlerRedisLike {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode?: string,
    ttl?: number,
  ): Promise<'OK' | null>;
  pttl(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

const INCREMENT_SCRIPT = `
  local hits = redis.call('INCR', KEYS[1])
  if hits == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return hits
`;

export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: ThrottlerRedisLike) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `throttle:hits:${throttlerName}:${key}`;
    const blockKey = `throttle:block:${throttlerName}:${key}`;

    const blocked = await this.redis.get(blockKey);
    if (blocked !== null) {
      const msLeft = await this.redis.pttl(blockKey);
      return {
        totalHits: limit,
        timeToExpire: 0,
        isBlocked: true,
        timeToBlockExpire: Math.max(Math.ceil(msLeft / 1000), 0),
      };
    }

    const hits = (await this.redis.eval(
      INCREMENT_SCRIPT,
      1,
      hitsKey,
      String(ttl),
    )) as number;

    if (hits > limit) {
      await this.redis.set(blockKey, '1', 'PX', blockDuration);
      return {
        totalHits: hits,
        timeToExpire: 0,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockDuration / 1000),
      };
    }

    const msLeft = await this.redis.pttl(hitsKey);
    return {
      totalHits: hits,
      timeToExpire: Math.max(Math.ceil(msLeft / 1000), 0),
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}
