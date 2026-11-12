import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { LoggingService } from '../../logging/logging.service';
interface ErrorBody {
  statusCode: number;
  message: string | string[];
  error?: string;
  timestamp: string;
  path: string;
}
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggingService) {}
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType<GqlContextType>() === 'graphql') {
      const gqlContext = GqlExecutionContext.create(host as never);
      const path = gqlContext.getInfo()?.fieldName ?? 'graphql';
      this.logGraphqlException(exception, path);
      throw exception;
    }
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{
      method: string;
      originalUrl: string;
    }>();
    const path = `${request.method} ${request.originalUrl}`;
    const body = this.resolveBody(exception, path);
    if (body.statusCode >= 500) {
      this.logger.error(
        `Unhandled exception on ${path}: ${exception instanceof Error ? exception.stack : String(exception)}`,
        '',
      );
    } else {
      this.logger.warn(`Request ${path} failed: ${JSON.stringify(body.message)}`);
    }
    response.status(body.statusCode).json(body);
  }
  private logGraphqlException(exception: unknown, path: string): void {
    const isServerError = !(exception instanceof HttpException) || exception.getStatus() >= 500;
    if (isServerError) {
      this.logger.error(
        `Unhandled exception on GraphQL field "${path}": ${exception instanceof Error ? exception.stack : String(exception)}`,
        '',
      );
    } else {
      this.logger.warn(`GraphQL field "${path}" failed: ${(exception as Error).message}`);
    }
  }
  private resolveBody(exception: unknown, path: string): ErrorBody {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        return {
          statusCode,
          message: payload,
          error: HttpStatus[statusCode] ?? undefined,
          timestamp: new Date().toISOString(),
          path,
        };
      }
      const message = (
        payload as {
          message?: string | string[];
        }
      ).message;
      return {
        statusCode,
        message: message ?? 'Bad request',
        error:
          (
            payload as {
              error?: string;
            }
          ).error ?? HttpStatus[statusCode],
        timestamp: new Date().toISOString(),
        path,
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.resolvePrismaError(exception, path);
    }
    const rawStatus =
      (
        exception as {
          status?: unknown;
          statusCode?: unknown;
        }
      )?.status ??
      (
        exception as {
          statusCode?: unknown;
        }
      )?.statusCode;
    if (typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 500) {
      return {
        statusCode: rawStatus,
        message: exception instanceof Error ? exception.message : 'Bad request',
        error: HttpStatus[rawStatus] ?? undefined,
        timestamp: new Date().toISOString(),
        path,
      };
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'Internal Server Error',
      timestamp: new Date().toISOString(),
      path,
    };
  }
  private resolvePrismaError(
    exception: Prisma.PrismaClientKnownRequestError,
    path: string,
  ): ErrorBody {
    const target = (exception.meta?.target as string[] | undefined) ?? [];
    switch (exception.code) {
      case 'P2002':
        return {
          statusCode: HttpStatus.CONFLICT,
          message: `A record with this ${target.join(', ')} already exists`,
          error: 'Conflict',
          timestamp: new Date().toISOString(),
          path,
        };
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Record not found',
          error: 'Not Found',
          timestamp: new Date().toISOString(),
          path,
        };
      case 'P2003':
        return {
          statusCode: HttpStatus.CONFLICT,
          message: 'Referenced record is still in use',
          error: 'Conflict',
          timestamp: new Date().toISOString(),
          path,
        };
      case 'P2023':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Record not found',
          error: 'Not Found',
          timestamp: new Date().toISOString(),
          path,
        };
      default:
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Database error',
          error: 'Internal Server Error',
          timestamp: new Date().toISOString(),
          path,
        };
    }
  }
}
