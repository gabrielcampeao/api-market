import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { MailService } from '../mail/mail.service';
import { AuditLogService } from '../logging/audit-log.service';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { RequestContext } from '../common/utils/request-context.util';

const ctx: RequestContext = { ip: '127.0.0.1', userAgent: 'jest' };

describe('AuthService', () => {
  let service: AuthService;

  const txMock = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    refreshToken: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    passwordResetToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };

  const prismaMock = {
    ...txMock,
    $transaction: jest.fn((arg: unknown) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg as Promise<unknown>[]);
      }
      return (arg as (tx: typeof txMock) => Promise<unknown>)(txMock);
    }),
  };

  const jwtServiceMock = {
    signAsync: jest.fn().mockResolvedValue('signed-access-token'),
  };

  const configMock = {
    jwt: { accessTtl: '15m', refreshTtlDays: 7 },
    isProduction: true,
  } as unknown as AppConfigService;

  const mailMock = {
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    sendOrderConfirmation: jest.fn().mockResolvedValue(undefined),
  };

  const auditMock = { log: jest.fn().mockResolvedValue(undefined) };

  const preHash = (password: string) => createHash('sha256').update(password, 'utf8').digest('hex');
  const passwordHash = bcrypt.hashSync(preHash('password123'), 10);
  const baseUser = {
    id: 'user-1',
    email: 'jane@example.com',
    name: 'Jane',
    passwordHash,
    role: Role.USER,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: JwtService, useValue: jwtServiceMock },
        { provide: AppConfigService, useValue: configMock },
        { provide: MailService, useValue: mailMock },
        { provide: AuditLogService, useValue: auditMock },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  it('registers a new user and returns a token pair', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue(baseUser);
    prismaMock.refreshToken.create.mockResolvedValue({});

    const result = await service.register(
      { email: 'jane@example.com', name: 'Jane', password: 'password123' },
      ctx,
    );

    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'jane@example.com',
          passwordHash: expect.not.stringMatching(/^password123$/),
        }),
      }),
    );
    expect(result.accessToken).toBe('signed-access-token');
    expect(result.refreshToken).toBeTruthy();
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.register', userId: 'user-1' }),
    );
  });

  it('normalizes email whitespace and casing on register', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue(baseUser);
    prismaMock.refreshToken.create.mockResolvedValue({});

    await service.register(
      { email: '  Jane@Example.COM  ', name: 'Jane', password: 'password123' },
      ctx,
    );

    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'jane@example.com' },
    });
    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'jane@example.com',
        }),
      }),
    );
  });

  it('rejects duplicate emails on register', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);

    await expect(
      service.register(
        { email: 'jane@example.com', name: 'Jane', password: 'password123' },
        ctx,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('logs in with valid credentials', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    prismaMock.refreshToken.create.mockResolvedValue({});

    const result = await service.login(
      { email: 'jane@example.com', password: 'password123' },
      ctx,
    );

    expect(result.accessToken).toBe('signed-access-token');
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login' }),
    );
  });

  it('rejects invalid credentials', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);

    await expect(
      service.login(
        { email: 'jane@example.com', password: 'wrong-password' },
        ctx,
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login_failed' }),
    );
  });

  it('rejects a disabled account', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      ...baseUser,
      isActive: false,
    });

    await expect(
      service.login(
        { email: 'jane@example.com', password: 'password123' },
        ctx,
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rotates a valid refresh token', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      user: baseUser,
    });
    prismaMock.refreshToken.create.mockResolvedValue({});

    const result = await service.refresh({ refreshToken: 'valid-token' }, ctx);

    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rt-1', revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    expect(result.accessToken).toBe('signed-access-token');
  });

  it('rejects a revoked refresh token', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      userId: 'user-1',
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      user: baseUser,
    });

    await expect(
      service.refresh({ refreshToken: 'revoked-token' }, ctx),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('resets the password with a valid token', async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValue({
      id: 'prt-1',
      userId: 'user-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    await service.resetPassword(
      { token: 'reset-token', newPassword: 'newPassword123' },
      ctx,
    );

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          passwordHash: expect.not.stringMatching(/^newPassword123$/),
        }),
      }),
    );
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalled();
  });

  it('consumes the reset token atomically', async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValue({
      id: 'prt-1',
      userId: 'user-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });
    prismaMock.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.resetPassword(
        { token: 'reset-token', newPassword: 'newPassword123' },
        ctx,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('revokes prior unused reset tokens before creating a new one', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    prismaMock.passwordResetToken.create.mockResolvedValue({});

    await service.forgotPassword({ email: '  jane@example.com  ' }, ctx);

    expect(prismaMock.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', usedAt: null },
    });
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'jane@example.com' },
    });
  });
});
