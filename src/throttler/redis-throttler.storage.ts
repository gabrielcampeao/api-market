import { Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

// Shared with throttler-storage.factory.ts, which only needs `ping` for the boot health-check.
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

const NOT_BLOCKED: ThrottlerStorageRecord = {
  totalHits: 0,
  timeToExpire: 0,
  isBlocked: false,
  timeToBlockExpire: 0,
};

export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: ThrottlerRedisLike) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      return await this.doIncrement(key, ttl, limit, blockDuration, throttlerName);
    } catch (err) {
      // Redis dropping mid-run shouldn't 500 every request via the global
      // ThrottlerGuard — fail open (unrated) rather than take down the API.
      this.logger.warn(
        `Redis throttle check failed, allowing request through: ${err instanceof Error ? err.message : String(err)}`,
      );
      return NOT_BLOCKED;
    }
  }

  private async doIncrement(
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
