import { Router } from 'express';
import type { NextFunction,Request,Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { completeSaleSchema, moneyInputSchema, uuidSchema } from '@pos/contracts';
import type { AppConfig } from '../../config/env.js';
import { requirePermission } from '../../http/middleware/auth.js';
import { badRequest } from '../../shared/errors.js';
import { asyncHandler,sendData,validateBody } from '../../shared/http.js';
import { paymentCapabilities,createPaymentIntent,getPaymentIntent,listPaymentIntents,confirmManualPayment,cancelUnpaidManualPayment,simulatePayment,checkDarajaPayment,verifyPesapalPayment } from './service.js';

export function createPaymentRoutes({pool,config,authenticate}:{pool:pg.Pool;config:AppConfig;authenticate:(req:Request,res:Response,next:NextFunction)=>void}) {
  const router=Router();
  router.use(authenticate);
  router.param('id', (req, _res, next, value: string) => {
    if (!uuidSchema.safeParse(value).success) return next(badRequest('VALIDATION_ERROR', 'A valid payment identifier is required'));
    next();
  });
  router.get('/payments/configuration',requirePermission('sales.create'),asyncHandler(async (req,res)=>{sendData(res,paymentCapabilities(config,req.auth!.organizationId));}));
  router.get('/payments/intents',requirePermission('sales.view'),asyncHandler(async(req,res)=>{sendData(res,{intents:await listPaymentIntents(pool,req.auth!)});}));
  router.post('/payments/intents',requirePermission('sales.create'),validateBody(z.object({sale:completeSaleSchema,provider:z.enum(['manual','simulator','daraja_sandbox','pesapal_terminal']),phone:z.string().max(30).optional()})),asyncHandler(async(req,res)=>{sendData(res,{intent:await createPaymentIntent(pool,config,req.auth!,req.body,req)},201);}));
  router.get('/payments/intents/:id',requirePermission('sales.create'),asyncHandler(async(req,res)=>{sendData(res,{intent:await getPaymentIntent(pool,req.auth!,uuidSchema.parse(req.params.id))});}));
  router.post('/payments/intents/:id/manual-confirm',requirePermission('sales.create'),validateBody(z.object({reference:z.string().trim().min(4).max(64).regex(/^[a-zA-Z0-9-]+$/).refine(value=>!/[0-9]{13,}/.test(value),'Use the terminal transaction reference, never a card number'),amount:moneyInputSchema,confirmed:z.literal(true)})),asyncHandler(async(req,res)=>{sendData(res,{intent:await confirmManualPayment(pool,req.auth!,uuidSchema.parse(req.params.id),req.body,req)});}));
  router.post('/payments/intents/:id/manual-cancel',requirePermission('sales.create'),validateBody(z.object({ noPaymentReceived:z.literal(true) }).strict()),asyncHandler(async(req,res)=>{sendData(res,{intent:await cancelUnpaidManualPayment(pool,req.auth!,uuidSchema.parse(req.params.id),req)});}));
  router.post('/payments/intents/:id/simulate',requirePermission('sales.create'),validateBody(z.object({outcome:z.enum(['paid','failed','cancelled'])})),asyncHandler(async(req,res)=>{sendData(res,{intent:await simulatePayment(pool,config,req.auth!,uuidSchema.parse(req.params.id),req.body.outcome,req)});}));
  router.post('/payments/intents/:id/pesapal-verify',requirePermission('sales.create'),validateBody(z.object({ reference:z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{4,64}$/).refine(value=>!/[0-9]{13,}/.test(value),'Use the terminal confirmation code, never a card number') }).strict()),asyncHandler(async(req,res)=>{sendData(res,{intent:await verifyPesapalPayment(pool,config,req.auth!,uuidSchema.parse(req.params.id),req.body.reference,req)});}));
  router.post('/payments/intents/:id/check',requirePermission('sales.create'),asyncHandler(async(req,res)=>{sendData(res,{intent:await checkDarajaPayment(pool,config,req.auth!,uuidSchema.parse(req.params.id),req)});}));
  return router;
}
