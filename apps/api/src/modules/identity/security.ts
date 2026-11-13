import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { AppConfig } from '../../config/env.js';

export async function hashPassword(password: string, config: AppConfig): Promise<string> {
  return bcrypt.hash(password, config.bcryptRounds);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export function generateOpaqueToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashOpaqueToken(token: string, config: AppConfig): string {
  return createHash('sha256').update(`${config.refreshTokenPepper}.${token}`).digest('hex');
}
