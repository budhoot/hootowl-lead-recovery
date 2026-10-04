const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const { z } = require('zod');
const db = require('../db');
const router = express.Router();
router.use((req,res,next)=>{
 const expected=process.env.ADMIN_API_KEY;
 if (!expected || expected.length<32) return res.sendStatus(503);
 const token=req.get('Authorization') || '';
 const a=Buffer.from(token), b=Buffer.from(`Bearer ${expected}`);
 if(a.length!==b.length || !timingSafeEqual(a,b)) return res.sendStatus(401);
 next();
});
router.use(express.json({limit:'16kb'}));
const phone=z.string().regex(/^\+[1-9][0-9]{1,14}$/);
const schema=z.object({ name:z.string().trim().min(1).max(80), twilio_number:phone,
 destination_number:phone, booking_url:z.string().url().refine(v=>v.startsWith('https://')).optional(),
 recovery_enabled:z.boolean().default(false) }).refine(v=>v.twilio_number!==v.destination_number);
router.post('/clients',async(req,res)=>{
 const parsed=schema.safeParse(req.body);
 if(!parsed.success) return res.status(400).json({error:'Invalid client configuration.'});
 const v=parsed.data, connection=await db.connect();
 try {
  await connection.query('BEGIN');
  const client=(await connection.query('INSERT INTO clients(name,booking_url) VALUES($1,$2) RETURNING *',[v.name,v.booking_url||null])).rows[0];
  const route=(await connection.query(`INSERT INTO client_phone_numbers(client_id,twilio_number,destination_number,recovery_enabled)
    VALUES($1,$2,$3,$4) RETURNING *`,[client.id,v.twilio_number,v.destination_number,v.recovery_enabled])).rows[0];
  await connection.query('COMMIT'); res.status(201).json({client,route});
 } catch(error) { await connection.query('ROLLBACK'); if(error.code==='23505') return res.status(409).json({error:'Phone number already configured.'}); throw error; }
 finally {connection.release();}
});
router.patch('/phone-numbers/:id',async(req,res)=>{
 if(!/^[1-9][0-9]*$/.test(req.params.id)) return res.sendStatus(400);
 const parsed=z.object({is_active:z.boolean(),recovery_enabled:z.boolean()}).safeParse(req.body);
 if(!parsed.success) return res.sendStatus(400);
 const result=await db.query('UPDATE client_phone_numbers SET is_active=$2,recovery_enabled=$3 WHERE id=$1 RETURNING *',[req.params.id,parsed.data.is_active,parsed.data.recovery_enabled]);
 if(!result.rowCount) return res.sendStatus(404);
 res.json(result.rows[0]);
});
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
module.exports=router;
