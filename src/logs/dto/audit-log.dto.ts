import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuditLog } from '@prisma/client';

export class AuditLogDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({ format: 'uuid' })
  userId?: string | null;

  @ApiProperty({ example: 'auth.login' })
  action: string;

  @ApiPropertyOptional({ example: 'user' })
  entity?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  entityId?: string | null;

  @ApiPropertyOptional()
  metadata?: Record<string, unknown> | null;

  @ApiPropertyOptional()
  ip?: string | null;

  @ApiPropertyOptional()
  userAgent?: string | null;

  @ApiProperty()
  createdAt: Date;
}

export function toAuditLogDto(log: AuditLog): AuditLogDto {
  return {
    id: log.id,
    userId: log.userId,
    action: log.action,
    entity: log.entity,
    entityId: log.entityId,
    metadata: (log.metadata as Record<string, unknown> | null) ?? null,
    ip: log.ip,
    userAgent: log.userAgent,
    createdAt: log.createdAt,
  };
}
