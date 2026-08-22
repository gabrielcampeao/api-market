import { Global, Module } from '@nestjs/common';
import { LoggingService } from './logging.service';
import { AuditLogService } from './audit-log.service';

@Global()
@Module({
  providers: [LoggingService, AuditLogService],
  exports: [LoggingService, AuditLogService],
})
export class LoggingModule {}
