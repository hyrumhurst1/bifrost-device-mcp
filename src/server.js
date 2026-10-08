import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
export function createServer(bridge, policy){
  const server=new McpServer({name:'bifrost-device-mcp',version:'0.1.0'});
  const register=(name,description,inputSchema,fn)=>server.registerTool(name,{description,inputSchema:{...inputSchema,approvalId:z.string().uuid().optional()}},async(args,extra)=>{
    try{
      const {approvalId,...actionArgs}=args;
      const binding=name.startsWith('browser_')?await bridge.browserBinding():undefined;
      const epoch=policy?.epoch;
      const pending=policy?.authorize(name,{...actionArgs,...(binding?{browserBinding:binding}:{})},approvalId);
      const guard=()=>{if(policy?.epoch!==epoch)throw Error('Permissions changed; retry the action');if(binding&&(binding.version!==bridge.documentVersion||binding.url!==(bridge.page?.url()??'about:blank')))throw Error('Browser document changed; retry for fresh approval');};
      if(pending)return{content:[{type:'text',text:JSON.stringify(pending)}]};
      const result=await bridge.invoke(name,()=>fn(actionArgs,{...extra,guard}));
      if(result.image){const {image,...metadata}=result;return{content:[{type:'image',data:image,mimeType:'image/png'},{type:'text',text:JSON.stringify(metadata)}]};}
      return{content:[{type:'text',text:JSON.stringify(result)}]};
    }catch(error){return{isError:true,content:[{type:'text',text:String(error.message).slice(0,500)}]};}
  });
  register('workspace_list','List up to 1000 entries inside the authorized workspace',{path:z.string().max(2048).default('.')},a=>bridge.list(a.path));
  register('workspace_read','Read up to 32 KiB of a regular workspace file',{path:z.string().max(2048)},a=>bridge.read(a.path));
  register('terminal_tasks','List task names explicitly approved by the local operator',{},()=>({tasks:Object.keys(bridge.recipes)}));
  register('terminal_run','Run one exact operator-approved command recipe. No shell, user arguments, or approval bypass',{task:z.string().max(100),cwd:z.string().max(2048).default('.')},(a,e)=>bridge.run(a.task,a.cwd,e.signal,e.guard));
  register('browser_navigate','Navigate the isolated browser to an exact operator-approved origin',{url:z.string().url().max(8192)},(a,e)=>bridge.browserAction('navigate',a,e.guard));
  register('browser_snapshot','Get page title and text from the isolated browser',{},(a,e)=>bridge.browserAction('snapshot',a,e.guard));
  register('browser_click','Click in the isolated browser. Host must confirm consequential actions',{selector:z.string().min(1).max(1024)},(a,e)=>bridge.browserAction('click',a,e.guard));
  register('browser_fill','Fill an isolated browser field. Never enter credentials or personal secrets',{selector:z.string().min(1).max(1024),value:z.string().max(8192)},(a,e)=>bridge.browserAction('fill',a,e.guard));
  register('browser_screenshot','Capture the current isolated browser viewport; no persistent screenshot file',{},(a,e)=>bridge.browserAction('screenshot',a,e.guard));
  server.registerTool('session_status',{description:'Read bridge-session health and counts without filesystem paths, hostname, command data, or permission changes',inputSchema:{}},async()=>({content:[{type:'text',text:JSON.stringify(bridge.status(policy?.mode))}]}));
  server.registerTool('recent_receipts',{description:'Read up to 100 metadata-only receipts from this running bridge session; no outputs or persistent job execution',inputSchema:{limit:z.number().int().min(1).max(100).default(20)}},async({limit})=>({content:[{type:'text',text:JSON.stringify(bridge.recentReceipts(limit))}]}));
  server.registerTool('permissions_reduce',{description:'Reduce to Ask mode. The agent cannot increase permissions',inputSchema:{}},async()=>({content:[{type:'text',text:JSON.stringify(policy?.reduce()??{mode:'ask'})}]}));
  return server;
}
