import { ConflictException, Injectable, Logger, RequestTimeoutException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  constructor(private readonly prisma: PrismaService) {}
  async execute<T>(
    idempotencyKey: string | null,
    userId: string | undefined,
    route: string,
    requestHash: string,
    handler: () => Promise<{
      statusCode: number;
      body: T;
    }>,
    ttlMs = DEFAULT_TTL_MS,
  ): Promise<{
    statusCode: number;
    body: T;
  }> {
    if (!idempotencyKey) {
      return handler();
    }
    if (!userId) {
      throw new ConflictException('Idempotent routes require an authenticated user.');
    }
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
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          userId,
          route,
          requestHash,
          statusCode: 0,
          body: Prisma.JsonNull,
          expiresAt: new Date(Date.now() + ttlMs),
        },
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.waitForResult<T>(idempotencyKey, route, userId, requestHash);
      }
      throw err;
    }
    let result: {
      statusCode: number;
      body: T;
    };
    try {
      result = await handler();
    } catch (err) {
      await this.prisma.idempotencyKey.delete({
        where: { key_route_userId: { key: idempotencyKey, route, userId } },
      });
      throw err;
    }
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
    maxWaitMs = 10000,
    pollMs = 100,
  ): Promise<{
    statusCode: number;
    body: T;
  }> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const record = await this.prisma.idempotencyKey.findUnique({
        where: { key_route_userId: { key: idempotencyKey, route, userId } },
      });
      if (!record) {
        throw new ConflictException('The original request for this idempotency key failed; retry.');
      }
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
