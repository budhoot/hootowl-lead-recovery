const express=require('express');
const crypto=require('node:crypto');
const db=require('../db');
const {equal,hash,cookieToken,sameOrigin,requireOperator}=require('../auth');
const router=express.Router();
router.use(require('express-rate-limit').rateLimit({windowMs:60000,limit:20}));
router.use(express.json({limit:'4kb'}));
router.use((req,res,next)=>{res.set('Cache-Control','no-store'); next();});
router.post('/',async(req,res)=>{
 if(!sameOrigin(req)) return res.sendStatus(403);
 if(!process.env.ADMIN_API_KEY || process.env.ADMIN_API_KEY.length<32) return res.sendStatus(503);
 if(!equal(req.body?.key,process.env.ADMIN_API_KEY)) return res.status(401).json({error:'The operator key was not accepted.'});
 const token=crypto.randomBytes(32).toString('hex');
 await db.query('DELETE FROM operator_sessions WHERE expires_at<NOW()');
 await db.query("INSERT INTO operator_sessions VALUES($1,NOW()+INTERVAL '8 hours')",[hash(token)]);
 res.cookie('hootowl_session',token,{httpOnly:true,sameSite:'strict',secure:req.secure,path:'/',maxAge:8*3600000});
 res.json({authenticated:true});
});
router.get('/',requireOperator,(req,res)=>res.json({authenticated:true}));
router.delete('/',requireOperator,async(req,res)=>{
 const token=cookieToken(req); if(token) await db.query('DELETE FROM operator_sessions WHERE token_hash=$1',[hash(token)]);
 res.clearCookie('hootowl_session',{path:'/'});res.sendStatus(204);
});
module.exports=router;
