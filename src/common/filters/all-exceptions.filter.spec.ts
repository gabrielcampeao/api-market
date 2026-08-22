import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { LoggingService } from '../../logging/logging.service';

function httpHost(request: { method: string; originalUrl: string }, response: { status: jest.Mock; json: jest.Mock }) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

describe('AllExceptionsFilter', () => {
  const loggingMock = { error: jest.fn(), warn: jest.fn() } as unknown as LoggingService;
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    jest.clearAllMocks();
    filter = new AllExceptionsFilter(loggingMock);
  });

  // The chaos scenario: Postgres becomes unreachable mid-request. Prisma
  // surfaces that as PrismaClientInitializationError/UnknownRequestError,
  // neither of which is a PrismaClientKnownRequestError (those are for
  // *known* database errors like unique violations) — this is what proves
  // that class of failure still gets a clean, generic 500 instead of
  // crashing the process or leaking a stack trace to the client.
  it('turns an unrecognized database failure into a generic 500 without leaking internals', () => {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const request = { method: 'GET', originalUrl: '/api/products' };
    const dbError = new Prisma.PrismaClientInitializationError(
      "Can't reach database server at `postgres:5432`",
      '6.19.3',
    );

    filter.catch(dbError, httpHost(request, response));

    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = response.json.mock.calls[0][0];
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('postgres:5432');
    expect(loggingMock.error).toHaveBeenCalled();
  });

  it('maps a known Prisma unique-constraint error to 409, not 500', () => {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const request = { method: 'POST', originalUrl: '/api/auth/register' };
    const err = new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.19.3',
      meta: { target: ['email'] },
    });

    filter.catch(err, httpHost(request, response));

    expect(response.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(loggingMock.error).not.toHaveBeenCalled();
  });
});
