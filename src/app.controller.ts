import { Controller, Get, Inject } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import Redis from 'ioredis';
import { Public } from './common/decorators/public.decorator';
import { PrismaService } from './prisma/prisma.service';
import { REDIS_CLIENT } from './redis/redis.module';

export interface LivenessStatus {
  status: 'ok';
  uptime: number;
  timestamp: string;
}

export interface ReadinessStatus {
  status: 'ok' | 'degraded';
  timestamp: string;
  checks: {
    postgres: 'ok' | 'error';
    redis: 'ok' | 'error';
  };
}

@ApiTags('health')
@Controller('health')
@SkipThrottle({ auth: true })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe — process is running' })
  @ApiOkResponse({ description: 'Service is alive' })
  getLiveness(): LivenessStatus {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — PostgreSQL and Redis reachable' })
  @ApiOkResponse({ description: 'Service is ready' })
  async getReadiness(): Promise<ReadinessStatus> {
    const checks: { postgres: 'ok' | 'error'; redis: 'ok' | 'error' } = {
      postgres: 'ok',
      redis: 'ok',
    };

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      checks.postgres = 'error';
    }

    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        checks.redis = 'error';
      }
    } catch {
      checks.redis = 'error';
    }

    const healthy = checks.postgres === 'ok' && checks.redis === 'ok';
    return {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}
