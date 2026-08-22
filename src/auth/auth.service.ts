import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { comparePassword, hashPassword } from '../common/utils/password.util';
import { AppConfigService } from '../config/app-config.service';
import { MailService } from '../mail/mail.service';
import { AuditLogService } from '../logging/audit-log.service';
import { RequestContext } from '../common/utils/request-context.util';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { TokenPair } from './interfaces/auth.types';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1h

// A fixed, valid bcrypt hash with no corresponding real password — compared
// against on every login for a nonexistent user so the response time doesn't
// leak whether the email is registered (see comparePassword call in login()).
const DUMMY_PASSWORD_HASH = '$2a$10$sPuZYETthM9ojW2KsRIDmOvhX11kCPk1X0Pxy6Hw3uCokmafODVim';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
    private readonly mail: MailService,
    private readonly audit: AuditLogService,
  ) {}

  async register(dto: RegisterDto, ctx: RequestContext): Promise<TokenPair> {
    const email = normalizeEmail(dto.email);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await hashPassword(dto.password);
    const user = await this.prisma.user.create({
      data: { email, name: dto.name, passwordHash },
    });

    const tokens = await this.issueTokens(user);
    await this.audit.log({
      userId: user.id,
      action: 'auth.register',
      entity: 'user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return tokens;
  }

  async login(dto: LoginDto, ctx: RequestContext): Promise<TokenPair> {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Always run a bcrypt compare, even for a nonexistent user, against a
    // fixed dummy hash — otherwise a lookup miss short-circuits before
    // hashing and the response time itself reveals whether the email is
    // registered.
    const passwordOk = await comparePassword(
      dto.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !passwordOk) {
      await this.audit.log({
        action: 'auth.login_failed',
        entity: 'user',
        metadata: { email },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('This account has been disabled');
    }

    const tokens = await this.issueTokens(user);
    await this.audit.log({
      userId: user.id,
      action: 'auth.login',
      entity: 'user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return tokens;
  }

  async refresh(dto: RefreshDto, ctx: RequestContext): Promise<TokenPair> {
    const tokenHash = this.hashToken(dto.refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (
      !record ||
      record.revokedAt !== null ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!record.user.isActive) {
      throw new UnauthorizedException('This account has been disabled');
    }

    // Rotation: atomically revoke the token.  If another concurrent
    // request already revoked it, updateMany returns count=0.
    const revoked = await this.prisma.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) {
      throw new UnauthorizedException('Refresh token has already been used');
    }

    const tokens = await this.issueTokens(record.user);
    await this.audit.log({
      userId: record.userId,
      action: 'auth.refresh',
      entity: 'user',
      entityId: record.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return tokens;
  }

  async logout(
    dto: RefreshDto,
    userId: string,
    ctx: RequestContext,
  ): Promise<{ message: string }> {
    const tokenHash = this.hashToken(dto.refreshToken);
    const revoked = await this.prisma.refreshToken.updateMany({
      where: { tokenHash, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count > 0) {
      await this.audit.log({
        userId,
        action: 'auth.logout',
        entity: 'user',
        entityId: userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }
    return { message: 'Logged out successfully' };
  }

  async forgotPassword(
    dto: ForgotPasswordDto,
    ctx: RequestContext,
  ): Promise<{ message: string; devResetToken?: string }> {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    let devResetToken: string | undefined;
    if (user) {
      const rawToken = this.randomToken(32);
      await this.prisma.passwordResetToken.deleteMany({
        where: { userId: user.id, usedAt: null },
      });
      await this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: this.hashToken(rawToken),
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
        },
      });
      // Same reasoning as OrdersService.checkout: a throwing mail provider
      // must not turn into a response difference between "email exists" and
      // "email doesn't exist" — that would undo the anti-enumeration
      // property this endpoint otherwise has (uniform response either way).
      try {
        await this.mail.sendPasswordReset(email, rawToken);
      } catch (err) {
        this.logger.warn(
          `Failed to send password reset email to ${email}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await this.audit.log({
        userId: user.id,
        action: 'auth.password_reset_requested',
        entity: 'user',
        entityId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      // Expose the token in non-production environments for local testing only.
      if (!this.config.isProduction) {
        devResetToken = rawToken;
      }
    }

    // Always answer the same way to avoid user enumeration.
    return {
      message:
        'If an account exists for that email, a password reset token has been sent.',
      ...(devResetToken ? { devResetToken } : {}),
    };
  }

  async resetPassword(
    dto: ResetPasswordDto,
    ctx: RequestContext,
  ): Promise<{ message: string }> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hashToken(dto.token) },
      include: { user: true },
    });

    if (
      !record ||
      record.usedAt !== null ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const passwordHash = await hashPassword(dto.newPassword);
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count === 0) {
        throw new BadRequestException('Invalid or expired reset token');
      }

      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      });
      await tx.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await this.audit.log({
      userId: record.userId,
      action: 'auth.password_reset',
      entity: 'user',
      entityId: record.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { message: 'Password updated. Please log in again.' };
  }

  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async getProfile(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return user;
  }

  private async issueTokens(user: User): Promise<TokenPair> {
    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshToken = this.randomToken(48);
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(
          Date.now() + this.config.jwt.refreshTtlDays * 24 * 60 * 60 * 1000,
        ),
      },
    });

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private randomToken(bytes: number): string {
    return randomBytes(bytes).toString('base64url');
  }
}
