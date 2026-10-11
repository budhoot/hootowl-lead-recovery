const crypto = require('node:crypto');
const db = require('./db');
function equal(a,b) { if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && crypto.timingSafeEqual(x,y); }
function cookieToken(req) {return (req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('hootowl_session='))?.slice(16);}
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function sameOrigin(req) {
 const origin=req.get('Origin');
 if(!origin || origin === `${req.protocol}://${req.get('host')}`) return true;
 // HTTPS may terminate at the configured tunnel/reverse proxy.
 try {const publicUrl=new URL(process.env.TWILIO_PUBLIC_BASE_URL);return origin===publicUrl.origin && req.get('host')===publicUrl.host;} catch {return false;}
}
async function requireOperator(req,res,next) {
 res.set('Cache-Control','no-store');
 const key=process.env.ADMIN_API_KEY;
 if(!key || key.length<32) return res.sendStatus(503);
 if(equal(req.get('Authorization'),`Bearer ${key}`)) return next();
 const token=cookieToken(req);
 if(!token || !/^[a-f0-9]{64}$/.test(token)) return res.sendStatus(401);
 if(!['GET','HEAD'].includes(req.method) && (!sameOrigin(req) || req.get('X-HootOwl-Request')!=='operator')) return res.sendStatus(403);
 const result=await db.query('SELECT 1 FROM operator_sessions WHERE token_hash=$1 AND expires_at>NOW()',[hash(token)]);
 if(!result.rowCount) return res.sendStatus(401);
 next();
}
module.exports={equal,hash,cookieToken,sameOrigin,requireOperator};
