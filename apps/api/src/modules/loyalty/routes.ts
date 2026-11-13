import { Router } from 'express';
import type { RequestHandler } from 'express';
import type pg from 'pg';
import { uuidSchema } from '@pos/contracts';
import { requirePermission } from '../../http/middleware/auth.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import { customerLoyalty, loyaltySettings, loyaltySettingsSchema, updateLoyaltySettings } from './service.js';
export function createLoyaltyRoutes(pool:pg.Pool,authenticate:RequestHandler) {
  const router=Router(); router.use(authenticate);
  router.get('/loyalty/settings',requirePermission('sales.create'),asyncHandler(async(req,res)=>{sendData(res,{settings:await loyaltySettings(pool,req.auth!.organizationId)});}));
  router.patch('/loyalty/settings',requirePermission('settings.manage'),validateBody(loyaltySettingsSchema),asyncHandler(async(req,res)=>{sendData(res,{settings:await updateLoyaltySettings(pool,req.auth!,req.body,req)});}));
  router.get('/loyalty/customers/:customerId',requirePermission('sales.create'),asyncHandler(async(req,res)=>{sendData(res,await customerLoyalty(pool,req.auth!.organizationId,uuidSchema.parse(req.params.customerId)));}));
  return router;
}
