import { Test } from '@nestjs/testing';
import { ConflictException, RequestTimeoutException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdempotencyService } from './idempotency.service';
import { PrismaService } from '../prisma/prisma.service';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique constraint', {
    code: 'P2002',
    clientVersion: '6.0.0',
  });
}

describe('IdempotencyService', () => {
  let service: IdempotencyService;

  const prismaMock = {
    idempotencyKey: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [IdempotencyService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();
    service = moduleRef.get(IdempotencyService);
  });

  it('runs the handler directly when no key is provided', async () => {
    const handler = jest.fn().mockResolvedValue({ statusCode: 201, body: { ok: true } });
    const result = await service.execute(null, 'user-1', 'POST /x', 'hash-a', handler);
    expect(result.body).toEqual({ ok: true });
    expect(prismaMock.idempotencyKey.findUnique).not.toHaveBeenCalled();
  });

  it('persists the result on first use of a key', async () => {
    prismaMock.idempotencyKey.findUnique.mockResolvedValue(null);
    prismaMock.idempotencyKey.create.mockResolvedValue({});
    const handler = jest.fn().mockResolvedValue({ statusCode: 201, body: { id: 1 } });

    const result = await service.execute('key-1', 'user-1', 'POST /orders/checkout', 'hash-a', handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(prismaMock.idempotencyKey.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ requestHash: 'hash-a' }) }),
    );
    expect(prismaMock.idempotencyKey.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ statusCode: 201 }) }),
    );
    expect(result.body).toEqual({ id: 1 });
  });

  it('returns the cached response for a repeat request with the same body', async () => {
    prismaMock.idempotencyKey.findUnique.mockResolvedValue({
      requestHash: 'hash-a',
      statusCode: 201,
      body: { id: 1 },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const handler = jest.fn();

    const result = await service.execute('key-1', 'user-1', 'POST /orders/checkout', 'hash-a', handler);

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ statusCode: 201, body: { id: 1 } });
  });

  it('rejects a reused key with a different request body', async () => {
    prismaMock.idempotencyKey.findUnique.mockResolvedValue({
      requestHash: 'hash-a',
      statusCode: 201,
      body: { id: 1 },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const handler = jest.fn();

    await expect(
      service.execute('key-1', 'user-1', 'POST /orders/checkout', 'hash-b', handler),
    ).rejects.toThrow(ConflictException);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects immediately (no polling) when a concurrent request used a different body', async () => {
    prismaMock.idempotencyKey.findUnique
      .mockResolvedValueOnce(null) // pre-create lookup: nothing yet
      .mockResolvedValueOnce({
        // waitForResult's first read sees the winner's row
        requestHash: 'hash-a',
        statusCode: 0,
        body: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
    prismaMock.idempotencyKey.create.mockRejectedValue(p2002());
    const handler = jest.fn();

    await expect(
      service.execute('key-1', 'user-1', 'POST /orders/checkout', 'hash-b', handler),
    ).rejects.toThrow(ConflictException);
    expect(handler).not.toHaveBeenCalled();
    // Only the one lookup inside waitForResult — no poll loop was entered.
    expect(prismaMock.idempotencyKey.findUnique).toHaveBeenCalledTimes(2);
  });

  it('waits for and returns the winning concurrent request\'s result when the body matches', async () => {
    prismaMock.idempotencyKey.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ requestHash: 'hash-a', statusCode: 0, body: null, expiresAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ requestHash: 'hash-a', statusCode: 201, body: { id: 7 }, expiresAt: new Date(Date.now() + 60_000) });
    prismaMock.idempotencyKey.create.mockRejectedValue(p2002());
    const handler = jest.fn();

    const result = await service.execute('key-1', 'user-1', 'POST /orders/checkout', 'hash-a', handler);

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ statusCode: 201, body: { id: 7 } });
  });

  it('lets a retry proceed once the original attempt failed and released the lock', async () => {
    prismaMock.idempotencyKey.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null); // winner's row is gone — it errored and deleted it
    prismaMock.idempotencyKey.create.mockRejectedValue(p2002());
    const handler = jest.fn();

    await expect(
      service.execute('key-1', 'user-1', 'POST /orders/checkout', 'hash-a', handler),
    ).rejects.toThrow(ConflictException);
  });

  it('times out if the original request never finishes within the wait window', async () => {
    jest.useFakeTimers();
    prismaMock.idempotencyKey.findUnique.mockResolvedValue({
      requestHash: 'hash-a',
      statusCode: 0,
      body: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prismaMock.idempotencyKey.create.mockRejectedValue(p2002());
    const handler = jest.fn();

    const promise = service.execute('key-1', 'user-1', 'POST /orders/checkout', 'hash-a', handler);
    const assertion = expect(promise).rejects.toThrow(RequestTimeoutException);
    await jest.advanceTimersByTimeAsync(11_000);
    await assertion;
    jest.useRealTimers();
  });
});
