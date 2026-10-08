#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import readline from 'node:readline';
import { Policy } from './policy.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Bridge } from './bridge.js';
import { createServer } from './server.js';

if(!process.env.BIFROST_WORKSPACE)throw Error('Set BIFROST_WORKSPACE to a dedicated workspace, separate from the bridge installation');
const workspace=await fs.realpath(process.env.BIFROST_WORKSPACE);
const installation=await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
if(installation===workspace||installation.startsWith(workspace+path.sep))throw Error('Workspace must not contain the bridge installation');
let recipes={};
if(process.env.BIFROST_POLICY){
  const policy=await fs.realpath(process.env.BIFROST_POLICY);
  if(policy===workspace||policy.startsWith(workspace+path.sep))throw Error('Policy must be outside the model-accessible workspace');
  recipes=JSON.parse(await fs.readFile(policy,'utf8')).tasks ?? {};
}
const origins=JSON.parse(process.env.BIFROST_BROWSER_ORIGINS || '[]');
if(!Array.isArray(origins)||!origins.every(origin=>{try{return new URL(origin).origin===origin&&/^https?:/.test(origin);}catch{return false;}}))throw Error('Browser origins must be exact HTTP(S) origins');
if(process.env.BIFROST_AUDIT_FILE){const audit=await fs.open(process.env.BIFROST_AUDIT_FILE,'a',0o600);await audit.close();}
const bridge=await new Bridge({workspace,recipes,origins,executablePath:process.env.BIFROST_CHROMIUM_EXECUTABLE,auditFile:process.env.BIFROST_AUDIT_FILE}).init();
const policy=new Policy({mode:process.env.BIFROST_MODE||'auto'});
let approvalConsole;
if(process.env.BIFROST_APPROVAL_CONSOLE==='1'){
  if(process.platform==='win32')throw Error('Local approval console currently requires a POSIX terminal');
  const input=createReadStream('/dev/tty');const output=createWriteStream('/dev/tty');
  approvalConsole=readline.createInterface({input,output});
  output.write('Bifrost owner console: pending | approve REQUEST_ID | mode auto | mode ask. Bypass is unsupported.\n');
  approvalConsole.on('line',line=>{try{const [command,arg]=line.trim().split(/\s+/);if(command==='pending')output.write(JSON.stringify(policy.pendingLocal(),null,2)+'\n');else if(command==='approve'){policy.approveLocal(arg);output.write('Approved once\n');}else if(command==='mode'){policy.setLocal(arg);output.write('Mode '+policy.mode+'\n');}else output.write('Unknown command\n');}catch(error){output.write(error.message+'\n');}});
}
let listener;const servers=new Set();
async function shutdown(){approvalConsole?.close();await new Promise(resolve=>listener?listener.close(resolve):resolve());for(const server of servers)await server.close();await bridge.close();}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>shutdown().finally(()=>process.exit(0)));
if(process.env.BIFROST_TRANSPORT==='http'){
  const token=process.env.BIFROST_HTTP_TOKEN;
  if(!token||token.length<32)throw Error('HTTP requires an operator-provided token of at least 32 characters; this project does not generate credentials');
  const port=Number(process.env.BIFROST_PORT || 7331);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  let activeHttp=0;
  const expectedHost=`127.0.0.1:${port}`;
  listener=http.createServer(async(req,res)=>{
    const deny=(status,message)=>{res.writeHead(status,{'content-type':'text/plain'});res.end(message);};
    if(req.headers.host!==expectedHost||req.headers.origin)return deny(403,'Host or Origin not allowed');
    const given=Buffer.from(req.headers.authorization||'');const expected=Buffer.from(`Bearer ${token}`);
    if(given.length!==expected.length||!crypto.timingSafeEqual(given,expected))return deny(401,'Unauthorized');
    if(req.url!=='/mcp')return deny(404,'Not found');
    if(req.method!=='POST')return deny(405,'Only POST supported');
    if(activeHttp>=8)return deny(429,'Too many active requests');
    activeHttp++;res.once('close',()=>{activeHttp--;});
    let size=0;const chunks=[];
    try{
      for await(const chunk of req){size+=chunk.length;if(size>65536){deny(413,'Body too large');return;}chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const server=createServer(bridge,policy);servers.add(server);
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.once('close',()=>{server.close().catch(()=>{});servers.delete(server);});
      await server.connect(transport);await transport.handleRequest(req,res,body);
    }catch{if(!res.headersSent)deny(400,'Invalid MCP request');else res.end();}
  });
  listener.requestTimeout=15000;listener.headersTimeout=10000;
  listener.listen(port,'127.0.0.1',()=>process.stderr.write(`Bifrost listening on loopback port ${port}\n`));
}else{
  const server=createServer(bridge,policy);servers.add(server);await server.connect(new StdioServerTransport());
  process.stdin.once('end',()=>shutdown().catch(()=>{}));
}
