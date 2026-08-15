import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildPaginationMeta, PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { AuditLogDto, toAuditLogDto } from './dto/audit-log.dto';
import { QueryLogsDto } from './dto/query-logs.dto';

@Injectable()
export class LogsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryLogsDto): Promise<PaginatedResponseDto<AuditLogDto>> {
    const { page, limit } = query;

    const where: Prisma.AuditLogWhereInput = {};
    if (query.action) {
      where.action = query.action;
    }
    if (query.userId) {
      where.userId = query.userId;
    }
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) {
        where.createdAt.gte = new Date(query.from);
      }
      if (query.to) {
        where.createdAt.lte = new Date(query.to);
      }
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return new PaginatedResponseDto(
      rows.map(toAuditLogDto),
      buildPaginationMeta(total, page, limit),
    );
  }
}
