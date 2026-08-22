import { Request } from 'express';

export interface RequestContext {
  ip: string;
  userAgent: string;
}

export function getRequestContext(req: Request): RequestContext {
  // req.ip / req.ips only reflect X-Forwarded-For when Express's
  // `trust proxy` setting is enabled (see main.ts, gated by TRUST_PROXY).
  // Reading the header directly here would let any client spoof the IP
  // recorded in audit logs when the app isn't actually behind a proxy.
  return {
    ip: req.ip ?? 'unknown',
    userAgent: req.headers['user-agent'] ?? 'unknown',
  };
}
