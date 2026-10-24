// Normalized server-to-server intake for a Wix Automation HTTP action.
// This is not the Wix app JWT webhook format and never authorizes SMS sends.
const express=require('express');
const {z}=require('zod');
const {equal}=require('../auth');
const db=require('../db');
const billing=require('../billing');
const onboarding=require('../onboarding');
const router=express.Router();
router.use(require('express-rate-limit').rateLimit({windowMs:60000,limit:120}));
router.use(express.json({limit:'16kb'}));
// Wix Automations cannot set headers, so the secret may also arrive as a body field (never in the URL, which proxies log).
router.use((req,res,next)=>{
 const secret=process.env.WIX_INTAKE_SECRET;
 if(!secret || secret.length<32) return res.sendStatus(503);
 const given=req.get('Authorization') || (typeof req.body?.secret==='string' ? `Bearer ${req.body.secret}` : '');
 if(!equal(given,`Bearer ${secret}`)) return res.sendStatus(401);
 next();
});
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
router.post('/billing/events',async(req,res)=>{
 const parsed=z.object({event_id:z.string().trim().min(1).max(200),event_type:z.enum(billing.EVENT_TYPES),
 plan_id:z.string().trim().min(1).max(200),subscription_id:z.string().trim().max(200).optional(),
 buyer_email:z.string().email().max(254),period_end:z.string().datetime().optional(),
 occurred_at:z.string().datetime().optional()}).safeParse(req.body);
 if(!parsed.success) return res.status(400).json({error:'Invalid billing event.'});
 const result=await billing.applyWixEvent(parsed.data);
 res.status(result.duplicate?200:202).json({accepted:true,duplicate:!!result.duplicate,outcome:result.outcome||null});
});
// Wix Automations "Send HTTP request" step for Pricing Plans triggers. Missing values arrive as empty strings.
const blank=v=>typeof v==='string'&&!v.trim()?undefined:v;
const automationSchema=z.object({secret:z.string().optional(),event:z.enum(['plan_purchased','plan_cancelled','plan_expired']),
 plan_id:z.string().trim().min(1).max(200),order_id:z.string().trim().min(1).max(160),
 email:z.string().trim().email().max(254).transform(v=>v.toLowerCase()),
 first_name:z.preprocess(blank,z.string().trim().max(60).optional()),last_name:z.preprocess(blank,z.string().trim().max(60).optional()),
 valid_until:z.preprocess(blank,z.string().datetime().optional())});
router.post('/automation',async(req,res)=>{
 const parsed=automationSchema.safeParse(req.body);
 if(!parsed.success) return res.status(400).json({error:'Invalid automation request.'});
 const v=parsed.data;
 let result=await billing.applyWixEvent({event_id:`${v.event}:${v.order_id}`,event_type:v.event,plan_id:v.plan_id,
  subscription_id:v.order_id,buyer_email:v.email,period_end:v.valid_until,occurred_at:new Date().toISOString()});
 const base=process.env.TWILIO_PUBLIC_BASE_URL;
 let onboardingLink=new URL('/portal/',base).toString(), invited=false;
 // A Wix retry repeats the purchase; issuing a fresh link is right because the failed run never emailed the old one.
 if(v.event==='plan_purchased' && billing.isKnownPlan(v.plan_id)){
  const name=[v.first_name,v.last_name].filter(Boolean).join(' ')||v.email;
  const customer=await onboarding.ensureCustomer(v.email,name.slice(0,80));
  if(customer.invitation_path){ onboardingLink=new URL(customer.invitation_path,base).toString(); invited=true; }
  if(result.outcome==='unmatched'){ await billing.reconcileUnmatched(); result={...result,outcome:await billing.isSubscriptionActive(customer.client_id)?'applied':'unmatched'}; }
 }
 res.status(result.duplicate?200:202).json({accepted:true,duplicate:!!result.duplicate,outcome:result.outcome||null,invited,onboarding_link:onboardingLink});
});
module.exports=router;
