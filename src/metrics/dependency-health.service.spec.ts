import { Test } from '@nestjs/testing';
import { DependencyHealthService } from './dependency-health.service';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { MetricsService } from './metrics.service';

describe('DependencyHealthService', () => {
  let service: DependencyHealthService;

  const prismaMock = { $queryRaw: jest.fn() };
  const redisMock = { ping: jest.fn() };
  const metrics = new MetricsService();

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DependencyHealthService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: REDIS_CLIENT, useValue: redisMock },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();
    service = moduleRef.get(DependencyHealthService);
  });

  it('sets both dependencies up when both checks succeed', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redisMock.ping.mockResolvedValue('PONG');

    await service.checkDependencies();

    const output = await metrics.getMetrics();
    expect(output).toContain('dependency_up{dependency="postgres"} 1');
    expect(output).toContain('dependency_up{dependency="redis"} 1');
  });

  it('sets postgres down when the query throws, without affecting redis', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('connection refused'));
    redisMock.ping.mockResolvedValue('PONG');

    await service.checkDependencies();

    const output = await metrics.getMetrics();
    expect(output).toContain('dependency_up{dependency="postgres"} 0');
    expect(output).toContain('dependency_up{dependency="redis"} 1');
  });

  it('sets redis down when ping throws or returns something other than PONG', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redisMock.ping.mockResolvedValue('WRONG');

    await service.checkDependencies();

    const output = await metrics.getMetrics();
    expect(output).toContain('dependency_up{dependency="redis"} 0');
  });
});
