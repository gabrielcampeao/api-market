import { Request } from 'express';
export interface RequestContext {
  ip: string;
  userAgent: string;
}
export function getRequestContext(req: Request): RequestContext {
  return {
    ip: req.ip ?? 'unknown',
    userAgent: req.headers['user-agent'] ?? 'unknown',
  };
}
