import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
export interface AuditLogParams {
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
}
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}
  async log(params: AuditLogParams): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: params.userId ?? null,
          action: params.action,
          entity: params.entity,
          entityId: params.entityId,
          metadata: params.metadata,
          ip: params.ip,
          userAgent: params.userAgent,
        },
      });
    } catch {
      return;
    }
  }
}
