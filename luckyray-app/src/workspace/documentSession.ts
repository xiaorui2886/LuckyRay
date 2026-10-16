/** One content session, independent editor selections/history/scroll per view.
 * Persisted layouts contain identity only. Drafts never enter layout storage.
 * Every save carries the revision last read; conflicts retain local text.
 */
export type DocumentIdentity={libraryId:string;resourceId:string};
export type DocumentSnapshot={content:string;revision:string;title?:string};
export type DocumentTransport={read:()=>Promise<DocumentSnapshot>;write:(content:string,revision:string)=>Promise<DocumentSnapshot>};
export type DocumentState={content:string;revision:string;status:'loading'|'ready'|'saving'|'error'|'conflict';dirty:boolean;error:string|null;remote:DocumentSnapshot|null};
export const documentKey=(identity:DocumentIdentity)=>JSON.stringify([identity.libraryId,identity.resourceId]);

export class DocumentSession {
  private state:DocumentState={content:'',revision:'',status:'loading',dirty:false,error:null,remote:null};
  private listeners=new Set<()=>void>();
  private transport:DocumentTransport;
  private generation=0;
  private activeSave:Promise<boolean>|null=null;
  private initialized:Promise<void>|null=null;
  private refreshRequested=false;
  private activeRefresh:Promise<void>|null=null;
  constructor(transport:DocumentTransport){this.transport=transport;}
  getSnapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(patch:Partial<DocumentState>){this.state={...this.state,...patch};for(const listener of this.listeners)listener();}
  load(){
    return this.initialized??=(async()=>{try{const doc=await this.transport.read();this.publish({...doc,status:'ready',dirty:false,error:null});}catch(error){this.publish({status:'error',error:String(error)});this.initialized=null;}})();
  }
  edit(content:string){if(!this.state.revision||content===this.state.content)return;this.generation++;this.publish({content,dirty:true,error:this.state.status==='conflict'?this.state.error:null});}
  /** Invalidation events carry no body. Serialize reads and re-read after a save
   * so an older response/our own write echo cannot replace a newer revision. */
  refresh():Promise<void>{
    this.refreshRequested=true;
    if(this.activeSave)return this.activeSave.then(()=>this.refresh());
    if(this.activeRefresh)return this.activeRefresh;
    this.activeRefresh=(async()=>{
      while(this.refreshRequested&&!this.activeSave){
        this.refreshRequested=false;
        const revision=this.state.revision;
        try{const remote=await this.transport.read();
          if(this.state.revision!==revision){this.refreshRequested=true;continue;}
          this.receive(remote);
        }
        catch(error){this.publish({error:String(error)});}
      }
    })().finally(()=>{this.activeRefresh=null;});
    return this.activeRefresh;
  }
  async flush():Promise<boolean>{
    if(this.activeSave){await this.activeSave;return this.state.status==='conflict'||this.state.status==='error'?false:this.flush();}
    if(this.state.status==='conflict'||!this.state.revision)return false;
    if(!this.state.dirty)return true;
    const {content,revision}=this.state,generation=this.generation;
    this.publish({status:'saving',error:null});
    this.activeSave=(async()=>{
      try{
        const saved=await this.transport.write(content,revision);
        this.publish({revision:saved.revision,status:'ready',dirty:this.generation!==generation,error:null,remote:null});return true;
      }catch(error){
        let remote:DocumentSnapshot|null=null;try{remote=await this.transport.read();}catch{/* Offline: preserve draft without guessing a new revision. */}
        const conflict=!!remote&&remote.revision!==revision;
        this.publish({status:conflict?'conflict':'error',error:String(error),remote,dirty:true});return false;
      }
    })();
    const success=await this.activeSave;this.activeSave=null;
    if(this.refreshRequested)await this.refresh();
    return success&&this.state.dirty?this.flush():success;
  }
  /** A missing/unloaded resource has no editable draft. It must remain closable
   * and must not trap application quit. Transfers still use strict flush(). */
  flushForClose():Promise<boolean>{return !this.state.revision&&!this.state.dirty?Promise.resolve(true):this.flush();}
  receive(remote:DocumentSnapshot){
    if(remote.revision===this.state.revision)return;
    // Own in-flight commit is acknowledged by write(); do not race its echo.
    if(this.activeSave){this.refreshRequested=true;return;}
    if(this.state.dirty){this.publish({status:'conflict',remote,error:'此笔记已在其他视图修改。你的输入仍保留，请比较两个版本。'});return;}
    this.publish({content:remote.content,revision:remote.revision,status:'ready',error:null,remote:null});
  }
  /** Caller must present an explicit choice; no automatic last-writer-wins. */
  resolveConflict(choice:'remote'|'keep-local'){
    const remote=this.state.remote;if(!remote)return;
    this.generation++;
    this.publish({revision:remote.revision,content:choice==='remote'?remote.content:this.state.content,dirty:choice==='keep-local',status:'ready',error:null,remote:null});
  }
}

export class DocumentSessions {
  private sessions=new Map<string,DocumentSession>();
  seed(identity:DocumentIdentity,session:DocumentSession){const key=documentKey(identity);if(!this.sessions.has(key))this.sessions.set(key,session);}
  get(identity:DocumentIdentity,transport:()=>DocumentTransport){const key=documentKey(identity);let session=this.sessions.get(key);if(!session){session=new DocumentSession(transport());this.sessions.set(key,session);}return session;}
  async flushAll(){return (await Promise.all([...this.sessions.values()].map(session=>session.flushForClose()))).every(Boolean);}
  hasDirty(){return [...this.sessions.values()].some(session=>session.getSnapshot().dirty);}
  receive(identity:DocumentIdentity,snapshot:DocumentSnapshot){this.sessions.get(documentKey(identity))?.receive(snapshot);}
}
