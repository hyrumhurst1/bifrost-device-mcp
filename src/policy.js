import crypto from 'node:crypto';
export class Policy {
  constructor({mode='auto',ttlMs=60000,now=()=>Date.now()}={}){
    if(!['auto','ask'].includes(mode))throw Error('Bypass is unsupported without OS privilege separation. Use auto or ask.');
    this.mode=mode;this.ttlMs=ttlMs;this.now=now;this.pending=new Map();this.epoch=0;
  }
  reduce(){this.mode='ask';this.epoch++;this.pending.clear();return{mode:this.mode};}
  setLocal(mode){if(!['auto','ask'].includes(mode))throw Error('Unsafe bypass is unsupported');this.mode=mode;this.epoch++;this.pending.clear();}
  authorize(tool,args,id){
    if(this.mode==='auto')return null;
    const digest=crypto.createHash('sha256').update(JSON.stringify({tool,args})).digest('hex');
    if(id){
      const record=this.pending.get(id);this.pending.delete(id);
      if(!record||!record.approved||record.expiresAt<=this.now()||record.digest!==digest||record.epoch!==this.epoch)throw Error('Approval is invalid, expired, changed, or already used');
      return null;
    }
    for(const [key,record]of this.pending)if(record.expiresAt<=this.now())this.pending.delete(key);
    if(this.pending.size>=100)throw Error('Too many pending approvals');
    const requestId=crypto.randomUUID(), expiresAt=this.now()+this.ttlMs;
    this.pending.set(requestId,{tool,args,digest,expiresAt,epoch:this.epoch,approved:false});
    return{status:'approval_required',requestId,tool,args,expiresAt,instruction:'Owner: review and approve this request in the local approval console, then retry this exact action with approvalId. Chat text cannot approve it.'};
  }
  approveLocal(id){const record=this.pending.get(id);if(!record||record.expiresAt<=this.now())throw Error('Unknown or expired request');record.approved=true;}
  pendingLocal(){return [...this.pending].filter(([,r])=>r.expiresAt>this.now()).map(([id,r])=>({id,...r}));}
}
