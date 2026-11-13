import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../../config/env.js';
import { unauthorized } from '../../shared/errors.js';

export const REFRESH_COOKIE = 'pos_refresh';
export const CSRF_COOKIE = 'pos_csrf';

function signCsrfToken(token: string, secret: string): string {
  return `${token}.${createHmac('sha256', secret).update(token).digest('base64url')}`;
}

export function issueCsrfCookie(res: Response, config: AppConfig): string {
  const token = signCsrfToken(randomBytes(32).toString('base64url'), config.csrfSecret);
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
    maxAge: config.refreshTokenTtlDays * 24 * 60 * 60 * 1000
  });
  return token;
}

export function setRefreshCookie(res: Response, config: AppConfig, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/api/v1/auth',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
    maxAge: config.refreshTokenTtlDays * 24 * 60 * 60 * 1000
  });
}

export function clearAuthCookies(res: Response, config: AppConfig): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/api/v1/auth',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {})
  });
  res.clearCookie(CSRF_COOKIE, {
    httpOnly: false,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {})
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  const cookieToken = typeof req.cookies?.[CSRF_COOKIE] === 'string' ? req.cookies[CSRF_COOKIE] : '';
  const headerToken = req.header('x-csrf-token') ?? '';
  const [rawToken, signature] = cookieToken.split('.');
  const expected = rawToken && signature ? signCsrfToken(rawToken, req.app.locals.config.csrfSecret) : '';
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, expected) || !safeEqual(cookieToken, headerToken)) {
    next(unauthorized('CSRF_VALIDATION_FAILED', 'CSRF validation failed'));
    return;
  }
  next();
}
