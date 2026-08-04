import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { comparePassword, hashPassword } from '../common/utils/password.util';
import { AuditLogService } from '../logging/audit-log.service';
import { RequestContext } from '../common/utils/request-context.util';
import { buildPaginationMeta, PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { toUserDto, UserDto } from '../common/mappers/user.mapper';
import { UpdateMeDto } from './dto/update-me.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async findById(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async updateMe(
    userId: string,
    dto: UpdateMeDto,
    ctx: RequestContext,
  ): Promise<User> {
    const user = await this.findById(userId);

    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) {
      data.name = dto.name;
    }
    if (dto.password !== undefined) {
      if (!dto.currentPassword) {
        throw new BadRequestException('currentPassword is required to change the password');
      }
      const ok = await comparePassword(dto.currentPassword, user.passwordHash);
      if (!ok) {
        throw new ForbiddenException('Current password is incorrect');
      }
      data.passwordHash = await hashPassword(dto.password);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: userId }, data });

      // If the password was changed, drop all active sessions so the user
      // must re-authenticate with the new credentials.
      if (dto.password !== undefined) {
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      return u;
    });

    await this.audit.log({
      userId,
      action: 'user.update_self',
      entity: 'user',
      entityId: userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  }

  async findAll(query: QueryUsersDto): Promise<PaginatedResponseDto<UserDto>> {
    const { page, limit } = query;

    const where: Prisma.UserWhereInput = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.role !== undefined) {
      where.role = query.role;
    }
    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return new PaginatedResponseDto(
      rows.map(toUserDto),
      buildPaginationMeta(total, page, limit),
    );
  }

  async update(
    adminId: string,
    userId: string,
    dto: UpdateUserDto,
    ctx: RequestContext,
  ): Promise<UserDto> {
    const target = await this.findById(userId);

    if (adminId === userId && dto.role === Role.USER) {
      throw new BadRequestException('Admins cannot demote themselves');
    }
    if (adminId === userId && dto.isActive === false) {
      throw new BadRequestException('Admins cannot deactivate themselves');
    }

    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: userId }, data });

      // If the account was disabled, drop all active sessions atomically.
      if (dto.isActive === false) {
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      return u;
    });

    await this.audit.log({
      userId: adminId,
      action: 'user.update',
      entity: 'user',
      entityId: userId,
      metadata: {
        previous: { role: target.role, isActive: target.isActive },
        changes: dto,
      } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return toUserDto(updated);
  }

  async deactivate(
    adminId: string,
    userId: string,
    ctx: RequestContext,
  ): Promise<{ message: string }> {
    if (adminId === userId) {
      throw new BadRequestException('Admins cannot deactivate themselves');
    }
    const target = await this.findById(userId);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { isActive: false },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await this.audit.log({
      userId: adminId,
      action: 'user.deactivate',
      entity: 'user',
      entityId: userId,
      metadata: { email: target.email } as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { message: 'User deactivated' };
  }
}
