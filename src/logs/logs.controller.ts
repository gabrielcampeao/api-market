import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { SkipThrottle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { LogsService } from './logs.service';
import { Roles } from '../common/decorators/roles.decorator';
import { ApiPaginatedResponse } from '../common/decorators/api-paginated-response.decorator';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { AuditLogDto } from './dto/audit-log.dto';
import { QueryLogsDto } from './dto/query-logs.dto';

@ApiTags('logs')
@ApiBearerAuth()
@Controller('logs')
@SkipThrottle({ auth: true })
export class LogsController {
  constructor(private readonly logsService: LogsService) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List audit logs with pagination and filters (admin)' })
  @ApiPaginatedResponse(AuditLogDto)
  findAll(@Query() query: QueryLogsDto): Promise<PaginatedResponseDto<AuditLogDto>> {
    return this.logsService.findAll(query);
  }
}
