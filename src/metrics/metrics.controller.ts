import { Controller, Get, Header } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { MetricsService } from './metrics.service';

// Not part of the public API surface (ApiExcludeController keeps it out of
// the Swagger doc) — this is a scrape target for Prometheus, not a client
// endpoint. @Public() because Prometheus doesn't send a bearer token, same
// as the health endpoints.
@ApiExcludeController()
@Controller('metrics')
@SkipThrottle()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(): Promise<string> {
    return this.metrics.getMetrics();
  }
}
