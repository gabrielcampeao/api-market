import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { MetricsService } from './metrics.service';

// Same two checks as HealthController.getReadiness(), run on a timer instead
// of per-request — Prometheus scrapes /api/metrics, it never calls
// /api/health/ready, so without this dependency_up would never move. `up`
// alone (Prometheus's own per-target metric) can't tell "process is down"
// apart from "process is up but Postgres or Redis isn't", which is the
// distinction this exists to make alertable.
@Injectable()
export class DependencyHealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly metrics: MetricsService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async checkDependencies(): Promise<void> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      this.metrics.dependencyUp.set({ dependency: 'postgres' }, 1);
    } catch {
      this.metrics.dependencyUp.set({ dependency: 'postgres' }, 0);
    }

    try {
      const pong = await this.redis.ping();
      this.metrics.dependencyUp.set({ dependency: 'redis' }, pong === 'PONG' ? 1 : 0);
    } catch {
      this.metrics.dependencyUp.set({ dependency: 'redis' }, 0);
    }
  }
}
