// Explicitly creates a NEW development database after the original Docker state was lost.
const fs=require('node:fs');const {execFileSync}=require('node:child_process');
require('dotenv').config({quiet:true});
const url=new URL(process.env.DATABASE_URL);
const run=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
try {run(['inspect','hootowl-postgres']);throw Error('Existing database found; refusing to replace it.');}
catch(error){if(!error.status)throw error;}
try{run(['network','inspect','hootowl-network']);}catch{run(['network','create','hootowl-network']);}
fs.mkdirSync('local',{recursive:true});
const envFile='local/postgres.env';
fs.writeFileSync(envFile,`POSTGRES_USER=${decodeURIComponent(url.username)}\nPOSTGRES_PASSWORD=${decodeURIComponent(url.password)}\nPOSTGRES_DB=${url.pathname.slice(1)}\n`);
run(['run','-d','--name','hootowl-postgres','--restart','unless-stopped','--network','hootowl-network','-p','127.0.0.1:5432:5432','--env-file',envFile,'-v','hootowl-development-data:/var/lib/postgresql/data','postgres:16']);
console.log('Created NEW PostgreSQL 16 development database in hootowl-development-data. Original data is not restored.');
