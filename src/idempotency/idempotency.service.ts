import {
  ConflictException,
  Injectable,
  Logger,
  RequestTimeoutException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Execute a handler with idempotency protection.
   *
   * If `idempotencyKey` is null the handler runs directly (no key provided).
   * On the first call the key is persisted and the result is cached.
   * Subsequent calls with the same key AND the same request body return the
   * cached response; the same key with a different body is rejected — it's
   * either a client bug (reusing a key across unrelated requests) or a
   * replay attempt, and silently serving the wrong cached response would be
   * worse than a 409. Expired keys are lazily cleaned up on lookup.
   */
  async execute<T>(
    idempotencyKey: string | null,
    userId: string | undefined,
    route: string,
    requestHash: string,
    handler: () => Promise<{ statusCode: number; body: T }>,
    ttlMs = DEFAULT_TTL_MS,
  ): Promise<{ statusCode: number; body: T }> {
    if (!idempotencyKey) {
      return handler();
    }
    if (!userId) {
      throw new ConflictException(
        'Idempotent routes require an authenticated user.',
      );
    }

    // Lazily evict expired key if one exists.
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key_route_userId: { key: idempotencyKey, route, userId } },
    });
    if (existing) {
      if (existing.expiresAt.getTime() <= Date.now()) {
        await this.prisma.idempotencyKey.delete({
          where: { key_route_userId: { key: idempotencyKey, route, userId } },
        });
      } else {
        this.assertSameRequest(existing.requestHash, requestHash);
        if (existing.statusCode !== 0) {
          return { statusCode: existing.statusCode, body: existing.body as T };
        }
        return this.waitForResult<T>(idempotencyKey, route, userId, requestHash);
      }
    }

    // Use a unique-constraint violation to detect a concurrent duplicate.
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          userId,
          route,
          requestHash,
          statusCode: 0, // placeholder
          body: Prisma.JsonNull,
          expiresAt: new Date(Date.now() + ttlMs),
        },
      });
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Concurrent request inserted the same key — the other request is
        // still running the handler. Wait for it to finish instead of
        // returning the statusCode:0 placeholder immediately.
        return this.waitForResult<T>(idempotencyKey, route, userId, requestHash);
      }
      throw err;
    }

    // Key locked.  Execute the handler.
    let result: { statusCode: number; body: T };
    try {
      result = await handler();
    } catch (err) {
      // Release the lock so a retry with the same key can proceed instead
      // of being stuck behind a stale placeholder row for the full TTL.
      await this.prisma.idempotencyKey.delete({
        where: { key_route_userId: { key: idempotencyKey, route, userId } },
      });
      throw err;
    }

    // Persist the result.
    await this.prisma.idempotencyKey.update({
      where: { key_route_userId: { key: idempotencyKey, route, userId } },
      data: {
        statusCode: result.statusCode,
        body: result.body as Prisma.InputJsonValue,
      },
    });

    return result;
  }

  private async waitForResult<T>(
    idempotencyKey: string,
    route: string,
    userId: string,
    requestHash: string,
    maxWaitMs = 10_000,
    pollMs = 100,
  ): Promise<{ statusCode: number; body: T }> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const record = await this.prisma.idempotencyKey.findUnique({
        where: { key_route_userId: { key: idempotencyKey, route, userId } },
      });
      if (!record) {
        // The winning request errored and released the lock — caller can retry.
        throw new ConflictException(
          'The original request for this idempotency key failed; retry.',
        );
      }
      // Checked every iteration (not just once) because the row we're
      // polling didn't exist yet when *this* request made its own request —
      // the first read after losing the create race is what tells us whose
      // body actually won.
      this.assertSameRequest(record.requestHash, requestHash);
      if (record.statusCode !== 0) {
        return { statusCode: record.statusCode, body: record.body as T };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new RequestTimeoutException(
      'Timed out waiting for the original request with this idempotency key to complete.',
    );
  }

  private assertSameRequest(storedHash: string, requestHash: string): void {
    if (storedHash !== requestHash) {
      throw new ConflictException(
        'This Idempotency-Key was already used with a different request body.',
      );
    }
  }

  async cleanupExpired(): Promise<number> {
    const result = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} expired idempotency keys`);
    }
    return result.count;
  }
}
