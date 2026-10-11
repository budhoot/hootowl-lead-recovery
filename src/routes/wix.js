// Normalized server-to-server intake for a Wix Automation HTTP action.
// This is not the Wix app JWT webhook format and never authorizes SMS sends.
const express=require('express');
const {z}=require('zod');
const {equal}=require('../auth');
const db=require('../db');
const router=express.Router();
router.use(require('express-rate-limit').rateLimit({windowMs:60000,limit:120}));
router.use((req,res,next)=>{
 const secret=process.env.WIX_INTAKE_SECRET;
 if(!secret || secret.length<32) return res.sendStatus(503);
 if(!equal(req.get('Authorization'),`Bearer ${secret}`)) return res.sendStatus(401);
 next();
});
router.use(express.json({limit:'16kb'}));
router.post('/leads',async(req,res)=>{
 const parsed=z.object({submission_id:z.string().trim().min(1).max(200),name:z.string().trim().min(1).max(120),
 email:z.string().email().max(254).optional(),phone:z.string().regex(/^\+[1-9][0-9]{1,14}$/).optional(),
 message:z.string().max(4000).default('')}).refine(v=>v.email||v.phone).safeParse(req.body);
 if(!parsed.success) return res.status(400).json({error:'Provide a unique submission_id, name, and valid email or international phone number.'});
 const v=parsed.data;
 const result=await db.query(`INSERT INTO website_leads(submission_id,name,email,phone,message) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(submission_id) DO NOTHING RETURNING id`,[v.submission_id,v.name,v.email||null,v.phone||null,v.message]);
 res.status(result.rowCount?201:200).json({accepted:true,duplicate:!result.rowCount});
});
module.exports=router;
