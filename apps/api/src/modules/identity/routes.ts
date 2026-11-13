import { timingSafeEqual } from 'node:crypto';
import { forbidden } from '../../shared/errors.js';
import { Router } from 'express';
import { z } from 'zod';
import { generateRecoveryCodes, ownerResetStaff, recoverAccount, recoveryStatus } from './recovery.js';
import {
  loginSchema,
  registerOrganizationSchema,
  requestPasswordResetSchema,
  resetPasswordSchema
} from '@pos/contracts';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import type { AppConfig } from '../../config/env.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import { REFRESH_COOKIE, clearAuthCookies, issueCsrfCookie, requireCsrf, setRefreshCookie } from '../../http/middleware/csrf.js';
import {
  listSessions,
  login,
  logout,
  refreshSession,
  registerOrganization,
  requestPasswordReset,
  resetPassword,
  revokeSession,
  type AuthBundle
} from './auth-service.js';

interface AuthRoutesDeps {
  pool: pg.Pool;
  systemPool: pg.Pool;
  config: AppConfig;
  authenticate: (req: Request, res: Response, next: NextFunction) => void;
}

function sendAuth(res: Response, config: AppConfig, bundle: AuthBundle, status = 200): void {
  setRefreshCookie(res, config, bundle.refreshToken);
  const csrfToken = issueCsrfCookie(res, config);
  sendData(res, {
    accessToken: bundle.accessToken,
    accessTokenExpiresIn: bundle.accessTokenExpiresIn,
    session: bundle.session,
    membership: bundle.membership,
    csrfToken
  }, status);
}

export function createAuthRoutes({ pool, systemPool, config, authenticate }: AuthRoutesDeps): Router {
  const router = Router();

  router.post('/register-organization', validateBody(registerOrganizationSchema), asyncHandler(async (req, res) => {
    if (config.cloud) {
      const supplied = req.header('x-pos-setup-key') ?? '';
      const expected = config.cloudSetupKey;
      if (!expected || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        throw forbidden('CLOUD_SETUP_RESTRICTED', 'Ask your hosting administrator for access to business setup.');
      }
    }
    const bundle = await registerOrganization(systemPool, config, req.body, req);
    sendAuth(res, config, bundle, 201);
  }));

  router.post('/login', validateBody(loginSchema), asyncHandler(async (req, res) => {
    const bundle = await login(systemPool, config, req.body, req);
    sendAuth(res, config, bundle);
  }));

  router.post('/refresh', requireCsrf, asyncHandler(async (req, res) => {
    const refreshToken = typeof req.cookies?.[REFRESH_COOKIE] === 'string' ? req.cookies[REFRESH_COOKIE] : undefined;
    if (!refreshToken) {
      res.status(401).json({ error: { code: 'SESSION_EXPIRED', message: 'Refresh session is missing', requestId: res.locals.requestId } });
      return;
    }
    const bundle = await refreshSession(systemPool, config, refreshToken, req);
    sendAuth(res, config, bundle);
  }));

  router.post('/logout', requireCsrf, asyncHandler(async (req, res) => {
    const refreshToken = typeof req.cookies?.[REFRESH_COOKIE] === 'string' ? req.cookies[REFRESH_COOKIE] : undefined;
    await logout(systemPool, config, refreshToken, req);
    clearAuthCookies(res, config);
    sendData(res, { loggedOut: true });
  }));

  router.post('/password-reset/request', validateBody(requestPasswordResetSchema), asyncHandler(async (req, res) => {
    const result = await requestPasswordReset(systemPool, config, req.body, req);
    sendData(res, {
      accepted: true,
      ...(result.resetToken ? { resetToken: result.resetToken } : {})
    });
  }));

  router.get('/recovery/status', authenticate, asyncHandler(async (req, res) => {
    sendData(res, await recoveryStatus(systemPool, req.auth!));
  }));
  router.post('/recovery/codes', authenticate, validateBody(z.object({ currentPassword: z.string().min(1).max(128) }).strict()), asyncHandler(async (req, res) => {
    sendData(res, await generateRecoveryCodes(systemPool, config, req.auth!, req.body.currentPassword, req));
  }));
  router.post('/recovery/confirm', validateBody(z.object({ email: z.string().trim().toLowerCase().email().max(254), code: z.string().min(1).max(100), password: z.string().min(1).max(128) }).strict()), asyncHandler(async (req, res) => {
    await recoverAccount(systemPool, config, req.body, req); clearAuthCookies(res, config); sendData(res, { passwordReset: true });
  }));
  router.post('/recovery/staff-reset', authenticate, validateBody(z.object({ membershipId: z.string().uuid(), currentPassword: z.string().min(1).max(128), password: z.string().min(1).max(128) }).strict()), asyncHandler(async (req, res) => {
    await ownerResetStaff(systemPool, config, req.auth!, req.body, req); sendData(res, { passwordReset: true });
  }));

  router.post('/password-reset/confirm', validateBody(resetPasswordSchema), asyncHandler(async (req, res) => {
    await resetPassword(systemPool, config, req.body, req);
    clearAuthCookies(res, config);
    sendData(res, { passwordReset: true });
  }));

  router.get('/me', authenticate, asyncHandler(async (req, res) => {
    sendData(res, { auth: req.auth ? { ...req.auth, permissions: [...req.auth.permissions] } : null });
  }));

  router.get('/sessions', authenticate, asyncHandler(async (req, res) => {
    sendData(res, { sessions: await listSessions(pool, req.auth!) });
  }));

  router.delete('/sessions/:sessionId', authenticate, asyncHandler(async (req, res) => {
    await revokeSession(pool, req.auth!, req.params.sessionId!, req);
    sendData(res, { revoked: true });
  }));

  return router;
}
