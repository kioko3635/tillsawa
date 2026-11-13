import { Router,type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type pg from 'pg';
import type { AppConfig } from '../../config/env.js';
import { requirePermission } from '../../http/middleware/auth.js';
import { asyncHandler,sendData,validateBody } from '../../shared/http.js';
import { forbidden,notFound } from '../../shared/errors.js';
import { snapshotSchema } from './schema.js';
import { connectStore,createNetworkStore,identifyNetworkStore,listLinks,listNetworkStores,receiveSnapshot,revokeNetworkStore,rotateNetworkStore,setLinkEnabled,syncLink } from './service.js';

export function createNetworkRoutes(pool:pg.Pool,systemPool:pg.Pool,config:AppConfig,authenticate:RequestHandler) {
  const router=Router();
  router.use('/network',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const machineLimit=rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false});
  const code=(header?:string)=>header?.startsWith('Bearer ')?header.slice(7):'';
  router.get('/network/machine/identify',machineLimit,asyncHandler(async(req,res)=>{sendData(res,await identifyNetworkStore(systemPool,config,code(req.header('authorization'))));}));
  router.post('/network/machine/snapshot',machineLimit,validateBody(snapshotSchema),asyncHandler(async(req,res)=>{sendData(res,await receiveSnapshot(systemPool,config,code(req.header('authorization')),req.body));}));
  router.use('/network',authenticate);
  router.get('/network/configuration',requirePermission('stores.view'),asyncHandler(async(_req,res)=>{sendData(res,{hub:!!config.multiStoreHub,intervalSeconds:60});}));
  router.get('/network/stores',requirePermission('stores.view'),asyncHandler(async(req,res)=>{sendData(res,{stores:await listNetworkStores(pool,config,req.auth!)});}));
  router.post('/network/stores',requirePermission('stores.manage'),validateBody(z.object({code:z.string().trim().min(1).max(40).regex(/^[a-zA-Z0-9-]+$/),name:z.string().trim().min(1).max(160)})),asyncHandler(async(req,res)=>{sendData(res,await createNetworkStore(pool,config,req.auth!,req.body),201);}));
  router.param('networkId',(req,_res,next,value:string)=>{const parsed=z.string().uuid().safeParse(value);if(!parsed.success)return next(notFound());next();});
  router.post('/network/stores/:networkId/rotate',requirePermission('stores.manage'),asyncHandler(async(req,res)=>{sendData(res,await rotateNetworkStore(pool,config,req.auth!,req.params.networkId!));}));
  router.post('/network/stores/:networkId/revoke',requirePermission('stores.manage'),asyncHandler(async(req,res)=>{sendData(res,await revokeNetworkStore(pool,config,req.auth!,req.params.networkId!));}));
  router.get('/network/links',requirePermission('stores.manage'),asyncHandler(async(req,res)=>{sendData(res,{links:await listLinks(pool,req.auth!)});}));
  router.post('/network/links',requirePermission('stores.manage'),validateBody(z.object({branchId:z.string().uuid(),hubUrl:z.string().max(500),pairingCode:z.string().max(200)})),asyncHandler(async(req,res)=>{sendData(res,await connectStore(pool,config,req.auth!,req.body),201);}));
  router.patch('/network/links/:networkId',requirePermission('stores.manage'),validateBody(z.object({enabled:z.boolean()})),asyncHandler(async(req,res)=>{sendData(res,await setLinkEnabled(pool,req.auth!,req.params.networkId!,req.body.enabled));}));
  router.post('/network/links/:networkId/sync',requirePermission('stores.manage'),asyncHandler(async(req,res)=>{
    if(config.multiStoreHub) throw forbidden('STORE_SERVICE_REQUIRED','Sync from the local store.');
    const own=await pool.query('SELECT id FROM network_links WHERE id=$1 AND organization_id=$2',[req.params.networkId,req.auth!.organizationId]);if(!own.rows[0])throw notFound();
    sendData(res,await syncLink(systemPool,config,req.params.networkId!));
  }));
  return router;
}
