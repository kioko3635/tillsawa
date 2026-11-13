import { createHmac, timingSafeEqual, verify } from 'node:crypto';
import { z } from 'zod';

export const activationRequestSchema = z.object({
  version: z.literal(1), organizationId: z.string().uuid(), shopName: z.string().min(1).max(200),
  installationId: z.string().uuid(), machineId: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export const licensePayloadSchema = activationRequestSchema.extend({
  licenseId: z.string().uuid(), plan: z.string().trim().min(1).max(80),
  issuedAt: z.string().datetime(), validFrom: z.string().datetime(), expiresAt: z.string().datetime().nullable(),
  lifetime: z.boolean().default(false), maxUsers: z.number().int().min(1).max(100000).nullable().default(null),
  graceDays: z.number().int().min(0).max(30), resetClock: z.boolean().default(false)
}).strict().refine(p => p.lifetime ? p.expiresAt === null : p.expiresAt !== null && Date.parse(p.expiresAt) > Date.parse(p.validFrom), 'A lifetime licence has no expiry; other licences require a valid expiry');
export const envelopeSchema = z.object({ payload: z.string().min(1).max(12000).regex(/^[A-Za-z0-9_-]+$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type LicensePayload = z.infer<typeof licensePayloadSchema>;
export type LicenseEnvelope = z.infer<typeof envelopeSchema>;
export type LicenseIdentity = { organizationId: string; installationId: string; machineId: string };

export function verifyLicense(input: unknown, publicKey: string, identity: LicenseIdentity): LicensePayload {
  const envelope = envelopeSchema.parse(input);
  const bytes = Buffer.from(envelope.payload, 'base64url');
  if (!verify(null, bytes, publicKey, Buffer.from(envelope.signature, 'base64url'))) throw new Error('This licence signature is not valid.');
  const payload = licensePayloadSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (payload.organizationId !== identity.organizationId || payload.installationId !== identity.installationId || payload.machineId !== identity.machineId) throw new Error('This licence belongs to a different shop or computer.');
  return payload;
}
export function stateMac(secret: string, identity: LicenseIdentity, highWater: number, envelope: unknown): string {
  const value = envelope as LicenseEnvelope | null;
  return createHmac('sha256', secret).update(JSON.stringify([identity.organizationId, identity.installationId, identity.machineId, highWater, value ? [value.payload, value.signature] : null])).digest('hex');
}
export function validMac(actual: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
export function evaluateLicense(payload: LicensePayload | null, now: number, highWater: number) {
  if (now + 300000 < highWater) return { state: 'clock_error', canWrite: false, message: 'The computer clock moved backwards. Correct the date and time, or contact support.' };
  if (!payload) return { state: 'unlicensed', canWrite: false, message: 'Activate this shop to start selling. Reports, backups and renewal remain available.' };
  const effectiveNow = Math.max(now, highWater);
  if (effectiveNow < Date.parse(payload.validFrom)) return { state: 'not_started', canWrite: false, message: 'This licence is not active yet. Check its start date and the computer clock.' };
  if (payload.lifetime || effectiveNow < Date.parse(payload.expiresAt!)) return { state: 'active', canWrite: true, message: payload.lifetime ? 'Your lifetime licence is active on this installation. There is no subscription expiry.' : 'Your subscription is active. You can continue selling without internet.' };
  if (effectiveNow < Date.parse(payload.expiresAt!) + payload.graceDays * 86400000) return { state: 'grace', canWrite: true, message: 'Your subscription has expired. Renew before the grace period ends to keep selling.' };
  return { state: 'expired', canWrite: false, message: 'Subscription expired. Import a renewal licence to resume changes and sales. Your records remain available.' };
}
