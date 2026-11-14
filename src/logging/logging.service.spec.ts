import { ConfigService } from '@nestjs/config';
import { LoggingService } from './logging.service';

describe('LoggingService', () => {
  it('redacts common secret formats before logging', () => {
    const service = new LoggingService({ get: () => 'development' } as unknown as ConfigService);
    const logger = service as unknown as {
      formatMessage(message: unknown, params: unknown[]): string;
    };

    expect(
      logger.formatMessage(
        'failed request with token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.a.b and password=secret',
        ['refresh token=abc123', 'sk_live_1234567890abcdef', 'whsec_1234567890abcdef'],
      ),
    ).toContain('[REDACTED_JWT]');
    expect(
      logger.formatMessage(
        'failed request with token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.a.b and password=secret',
        ['refresh token=abc123', 'sk_live_1234567890abcdef', 'whsec_1234567890abcdef'],
      ),
    ).toContain('password=[REDACTED]');
    expect(
      logger.formatMessage(
        'failed request with token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.a.b and password=secret',
        ['refresh token=abc123', 'sk_live_1234567890abcdef', 'whsec_1234567890abcdef'],
      ),
    ).not.toContain('sk_live_1234567890abcdef');
  });
});
