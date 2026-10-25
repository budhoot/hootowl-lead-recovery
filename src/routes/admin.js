const express = require('express');
const { z } = require('zod');
const db = require('../db');
const router = express.Router();
router.use(require('../auth').requireOperator);
router.use(express.json({limit:'16kb'}));
const phone=z.string().regex(/^\+[1-9][0-9]{1,14}$/);
const schema=z.object({ name:z.string().trim().min(1).max(80), twilio_number:phone,
 destination_number:z.union([z.literal(''),phone]).optional(), booking_url:z.string().url().refine(v=>v.startsWith('https://')).optional(),
 intake_enabled:z.boolean().default(false) })
 .refine(v=>v.intake_enabled||!!v.destination_number)
 .refine(v=>!v.destination_number||v.twilio_number!==v.destination_number);
router.post('/clients',async(req,res)=>{
 const parsed=schema.safeParse(req.body);
 if(!parsed.success) return res.status(400).json({error:'Invalid client configuration.'});
 const v=parsed.data, connection=await db.connect();
 try {
  await connection.query('BEGIN');
  const client=(await connection.query('INSERT INTO clients(name,booking_url) VALUES($1,$2) RETURNING *',[v.name,v.booking_url||null])).rows[0];
  const route=(await connection.query(`INSERT INTO client_phone_numbers(client_id,twilio_number,destination_number,recovery_enabled,intake_enabled)
    VALUES($1,$2,$3,FALSE,$4) RETURNING *`,[client.id,v.twilio_number,v.destination_number||null,v.intake_enabled])).rows[0];
  await connection.query('COMMIT'); res.status(201).json({client,route});
 } catch(error) { await connection.query('ROLLBACK'); if(error.code==='23505') return res.status(409).json({error:'Phone number already configured.'}); throw error; }
 finally {connection.release();}
});
router.patch('/phone-numbers/:id',async(req,res)=>{
 if(!/^[1-9][0-9]*$/.test(req.params.id)) return res.sendStatus(400);
 const parsed=z.object({is_active:z.boolean(),intake_enabled:z.boolean().optional()}).safeParse(req.body);
 if(!parsed.success) return res.sendStatus(400);
 const result=await db.query(`UPDATE client_phone_numbers
 SET is_active=$2,recovery_enabled=FALSE,intake_enabled=COALESCE($3,intake_enabled)
 WHERE id=$1 RETURNING *`,[req.params.id,parsed.data.is_active,parsed.data.intake_enabled??null]);
 if(!result.rowCount) return res.sendStatus(404);
 res.json(result.rows[0]);
});
const text=(min,max)=>z.string().trim().min(min).max(max);
const profileSchema=z.object({assistant_name:text(1,60),business_name:text(1,120),name_only_when_asked:z.boolean().default(true),
 started_on:z.union([z.literal(''),z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).default(''),greeting:text(1,300),closing_line:text(0,300).default(''),
 services:text(0,1000).default(''),service_latitude:z.number().min(-90).max(90).nullable().default(null),
 service_longitude:z.number().min(-180).max(180).nullable().default(null),service_radius_miles:z.number().int().min(1).max(500).default(100),
 service_area_label:text(0,200).default(''),place_hints:text(0,600).default(''),tts_provider:z.enum(['ElevenLabs','Google','Amazon']).default('ElevenLabs'),
 voice_id:z.union([z.literal(''),z.string().regex(/^[A-Za-z0-9._-]{1,100}$/)]).default(''),ready:z.boolean().default(false)})
 .strict().refine(v=>(v.service_latitude===null)===(v.service_longitude===null));
router.get('/agent-profiles/:clientId',async(req,res)=>{
 if(!/^[1-9][0-9]*$/.test(req.params.clientId)) return res.sendStatus(400);
 const row=(await db.query(`SELECT *,to_char(started_on,'YYYY-MM-DD') AS started_on FROM agent_profiles WHERE client_id=$1`,[req.params.clientId])).rows[0];
 if(!row) return res.sendStatus(404); res.json(row);
});
router.put('/agent-profiles/:clientId',async(req,res)=>{
 const parsed=profileSchema.safeParse(req.body);
 if(!parsed.success||!/^[1-9][0-9]*$/.test(req.params.clientId)) return res.status(400).json({error:'Invalid receptionist profile.'});
 const v=parsed.data;
 if(!(await db.query('SELECT 1 FROM clients WHERE id=$1',[req.params.clientId])).rowCount) return res.sendStatus(404);
 const row=(await db.query(`INSERT INTO agent_profiles(client_id,assistant_name,business_name,name_only_when_asked,started_on,greeting,closing_line,services,
 service_latitude,service_longitude,service_radius_miles,service_area_label,place_hints,tts_provider,voice_id,ready)
 VALUES($1,$2,$3,$4,NULLIF($5,'')::date,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULLIF($15,''),$16)
 ON CONFLICT(client_id) DO UPDATE SET assistant_name=EXCLUDED.assistant_name,business_name=EXCLUDED.business_name,
 name_only_when_asked=EXCLUDED.name_only_when_asked,started_on=EXCLUDED.started_on,greeting=EXCLUDED.greeting,closing_line=EXCLUDED.closing_line,
 services=EXCLUDED.services,service_latitude=EXCLUDED.service_latitude,service_longitude=EXCLUDED.service_longitude,
 service_radius_miles=EXCLUDED.service_radius_miles,service_area_label=EXCLUDED.service_area_label,place_hints=EXCLUDED.place_hints,
 tts_provider=EXCLUDED.tts_provider,voice_id=EXCLUDED.voice_id,ready=EXCLUDED.ready,updated_at=NOW()
 RETURNING client_id,ready`,[req.params.clientId,v.assistant_name,v.business_name,v.name_only_when_asked,v.started_on,v.greeting,v.closing_line,
  v.services,v.service_latitude,v.service_longitude,v.service_radius_miles,v.service_area_label,v.place_hints,v.tts_provider,v.voice_id,v.ready])).rows[0];
 res.json(row);
});
router.get('/voice-sessions',async(req,res)=>res.json((await db.query(`SELECT s.call_sid,s.caller_number,s.call_started_at,s.status,s.customer_name,s.service_type,
 s.service_address,s.issue_description,s.risk_flag,s.address_verified,s.callback_requested,s.booked_start,c.name
 FROM voice_agent_sessions s JOIN client_phone_numbers p ON p.id=s.client_phone_number_id JOIN clients c ON c.id=p.client_id
 ORDER BY s.created_at DESC LIMIT 100`)).rows));
router.get('/clients',async(req,res)=>res.json((await db.query(`SELECT p.*,c.name,c.booking_url FROM client_phone_numbers p JOIN clients c ON c.id=p.client_id ORDER BY p.id`)).rows));
router.get('/leads',async(req,res)=>{
 const clientId=req.query.client_id;
 if(!clientId || !/^[1-9][0-9]*$/.test(clientId)) return res.sendStatus(400);
 const missed=await db.query(`SELECT m.*,r.state,r.message_sid,r.delivery_status FROM missed_calls m
 JOIN client_phone_numbers p ON p.id=m.client_phone_number_id LEFT JOIN recovery_messages r ON r.call_sid=m.call_sid
 WHERE p.client_id=$1 ORDER BY m.created_at DESC LIMIT 200`,[clientId]);
 const replies=await db.query(`SELECT i.* FROM inbound_messages i JOIN client_phone_numbers p ON p.id=i.client_phone_number_id
 WHERE p.client_id=$1 ORDER BY i.created_at DESC LIMIT 200`,[clientId]);
 res.json({missed_calls:missed.rows,replies:replies.rows});
});
router.patch('/clients/:id',async(req,res)=>{
 if(!/^[1-9][0-9]*$/.test(req.params.id)) return res.sendStatus(400);
 const parsed=z.object({name:z.string().trim().min(1).max(80),booking_url:z.union([z.literal(''),z.string().url().refine(v=>v.startsWith('https://'))])}).safeParse(req.body);
 if(!parsed.success) return res.status(400).json({error:'Use a name and an HTTPS booking URL, or leave the URL empty.'});
 const result=await db.query('UPDATE clients SET name=$2,booking_url=$3 WHERE id=$1 RETURNING *',[req.params.id,parsed.data.name,parsed.data.booking_url||null]);
 if(!result.rowCount) return res.sendStatus(404);res.json(result.rows[0]);
});
router.patch('/routes/:id',async(req,res)=>{
 if(!/^[1-9][0-9]*$/.test(req.params.id)) return res.sendStatus(400);
 const parsed=z.object({destination_number:z.union([z.literal(''),phone]),is_active:z.boolean(),intake_enabled:z.boolean().optional()})
  .refine(v=>v.intake_enabled||!!v.destination_number).safeParse(req.body);
 if(!parsed.success) return res.status(400).json({error:'An active AI-answering route or forwarding number is required.'});
 const v=parsed.data;
 const result=await db.query(`UPDATE client_phone_numbers SET destination_number=$2::text,is_active=$3,recovery_enabled=FALSE,
 intake_enabled=COALESCE($4,intake_enabled)
 WHERE id=$1 AND ($2::text IS NULL OR twilio_number<>$2::text) RETURNING *`,[req.params.id,v.destination_number||null,v.is_active,v.intake_enabled ?? null]);
 if(!result.rowCount) return res.status(400).json({error:'Route not found or forwarding would loop back to the same number.'});res.json(result.rows[0]);
});
const followUp=z.object({status:z.enum(['new','in_progress','resolved']),notes:z.string().max(4000)});
router.patch('/missed-calls/:sid',async(req,res)=>{
 const parsed=followUp.safeParse(req.body);
 if(!parsed.success || req.params.sid.length>100) return res.sendStatus(400);
 const result=await db.query('UPDATE missed_calls SET follow_up_status=$2,operator_notes=$3 WHERE call_sid=$1 RETURNING *',[req.params.sid,parsed.data.status,parsed.data.notes]);
 if(!result.rowCount) return res.sendStatus(404);res.json(result.rows[0]);
});
router.get('/website-leads',async(req,res)=>res.json((await db.query('SELECT * FROM website_leads ORDER BY created_at DESC LIMIT 200')).rows));
router.patch('/website-leads/:id',async(req,res)=>{
 const parsed=followUp.safeParse(req.body);
 if(!parsed.success || !/^[1-9][0-9]*$/.test(req.params.id)) return res.sendStatus(400);
 const result=await db.query('UPDATE website_leads SET status=$2,operator_notes=$3 WHERE id=$1 RETURNING *',[req.params.id,parsed.data.status,parsed.data.notes]);
 if(!result.rowCount) return res.sendStatus(404);res.json(result.rows[0]);
});
router.get('/overview',async(req,res)=>{
 const result=await db.query(`SELECT
 (SELECT count(*) FROM clients) AS clients,
 (SELECT count(*) FROM missed_calls WHERE follow_up_status<>'resolved') AS open_calls,
 (SELECT count(*) FROM inbound_messages) AS replies,
 (SELECT count(*) FROM website_leads WHERE status<>'resolved') AS website_leads,
 (SELECT count(*) FROM recovery_messages WHERE state='pending') AS pending,
 (SELECT count(*) FROM recovery_messages WHERE state='review' OR (state='sending' AND updated_at<NOW()-INTERVAL '5 minutes')) AS review`);
 res.json(result.rows[0]);
});
router.get('/queue',async(req,res)=>res.json((await db.query(`SELECT r.*,c.name FROM recovery_messages r JOIN client_phone_numbers p ON p.id=r.client_phone_number_id
 JOIN clients c ON c.id=p.client_id ORDER BY r.created_at DESC LIMIT 200`)).rows));
router.post('/queue/:id/reconcile',async(req,res)=>{
 if(!/^[1-9][0-9]*$/.test(req.params.id)) return res.sendStatus(400);
 const parsed=z.object({outcome:z.enum(['sent','suppressed']),message_sid:z.string().regex(/^SM[a-f0-9]{32}$/i).optional()}).refine(v=>v.outcome!=='sent'||v.message_sid).safeParse(req.body);
 if(!parsed.success) return res.status(400).json({error:'A sent outcome requires a verified Twilio message SID.'});
 const result=await db.query(`UPDATE recovery_messages SET state=$2,message_sid=COALESCE($3,message_sid),updated_at=NOW()
 WHERE id=$1 AND (state='review' OR (state='sending' AND updated_at<NOW()-INTERVAL '5 minutes')) RETURNING *`,[req.params.id,parsed.data.outcome,parsed.data.message_sid||null]);
 if(!result.rowCount) return res.status(409).json({error:'This message is not eligible for reconciliation.'});res.json(result.rows[0]);
});
router.get('/system',async(req,res)=>{
 const heartbeat=(await db.query('SELECT last_seen,sending_enabled,last_seen>NOW()-INTERVAL \'45 seconds\' AS online FROM worker_heartbeat WHERE id=1')).rows[0];
 const count=(await db.query("SELECT count(*) FROM schema_migrations")).rows[0].count;
 res.json({database:'connected',migrations:Number(count),worker:heartbeat||{online:false},voice_agent_configured:!!(process.env.OPENAI_API_KEY&&process.env.TWILIO_AUTH_TOKEN&&process.env.TWILIO_PUBLIC_BASE_URL),
 twilio_credentials_configured:!!(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN),public_api_url:process.env.TWILIO_PUBLIC_BASE_URL||null,
 wix_site_url:process.env.WIX_SITE_URL||'https://www.hootowl.net',wix_intake_configured:!!process.env.WIX_INTAKE_SECRET,
 wix_last_received:(await db.query('SELECT max(created_at) AS at FROM website_leads')).rows[0].at,
 intake_path:'/integrations/wix/leads'});
});
module.exports=router;
