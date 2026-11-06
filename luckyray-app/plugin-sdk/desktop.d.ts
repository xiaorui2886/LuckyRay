/** API 2. Full-trust desktop code, NOT an isolation boundary. */
export type Dispose = () => void;
export type NoteRef = {vaultId:string;relativePath:string};
export type NoteSummary = {documentRef:NoteRef;title:string;relativePath:string;modifiedAt:string|null;size:number};
export type NoteSnapshot = NoteSummary & {content:string;revision:string};
export type NoteMutation = {document:NoteSnapshot;position:string;indexStale?:boolean};
export type ExtensionData = {schemaVersion:number;revision:number;settings:unknown;cache:unknown};
export type View = {id:string;title:string;mount(container:HTMLElement):void|Dispose|Promise<void|Dispose>};
export type EditorContext = {id:string;view:import('@codemirror/view').EditorView;modules:EditorModules};
export type EditorModules = {
 state:typeof import('@codemirror/state');view:typeof import('@codemirror/view');commands:typeof import('@codemirror/commands');language:typeof import('@codemirror/language');autocomplete:typeof import('@codemirror/autocomplete');
};
export type ProcessSnapshot = {events:{sequence:number;stream:string;base64:string}[];exitCode:number|null;settled:boolean;overflow:boolean};
export type ProcessHandle = {handle:string;write(base64:string):Promise<void>;closeInput():Promise<void>;poll():Promise<ProcessSnapshot>;kill():Promise<void>};
export type CanvasDocument = {schemaVersion:number;canvasId:string;name:string;createdAt:string;updatedAt:string;nodes:unknown[];edges:unknown[];viewport:{x:number;y:number;zoom:number};revision:number;contentDigest:string;generationHistory?:unknown[]};
export type CanvasEntry = {id:string;name:string;createdAt:string;updatedAt:string;revision?:number};
/** Event-bound writes retain their source across async work; invalid after the extension is retired. */
export type DesktopEventWriteContext = {
 knowledge:Pick<DesktopExtensionApi['knowledge'],'create'|'append'|'insert'|'replace'>;
 materials:Pick<DesktopExtensionApi['materials'],'library'|'importFiles'|'importFolder'>;
};
export interface DesktopExtensionApi {
 readonly apiVersion:2;readonly id:string;readonly version:string;
 modules:{React:typeof import('react');ReactDOM:typeof import('react-dom/client');codeMirror:EditorModules};
 lifecycle:{add(dispose:Dispose):Dispose;setInterval(fn:()=>void,ms:number):Dispose};
 workspace:{registerView(view:View):Dispose;openView(id:string,placement?:'main'|'left'|'right'|'modal'):void;closeView(id:string):void;onRouteChange(handler:(path:string)=>void):Dispose;getRoute():string};
 commands:{register(command:{id:string;name:string;shortcut?:string;allowInEditor?:boolean;run:()=>unknown}):Dispose;executeHost(command:'search.open'|'commandPalette.open'|'route.materials'|'route.notes'|'route.graph'|'route.canvas'|'route.community'|'route.ai'|'route.tags'|'route.collection'|'route.settings'|'note.create'|'note.closeTab'|'note.nextTab'|'note.prevTab'|'note.toggleIndex'|'asset.import'|'asset.toggleDetail'|'collection.captureClipboard'|'shell.toggleSidebar'):Promise<void>};
 menus:{register(target:'editor'|'materials',item:{id:string;label:string;when?:(context:unknown)=>boolean;run:(context:unknown)=>unknown}):Dispose};
 editor:{modules:EditorModules;current():EditorContext|null;list():EditorContext[];registerExtension(factory:(context:EditorContext)=>import('@codemirror/state').Extension):Dispose;onChange(handler:(event:{type:'opened'|'closed'|'changed'|'selection';editor:EditorContext})=>void):Dispose};
 markdown:{registerCodeBlock(language:string,render:(container:HTMLElement,source:string,context:{noteId:string|null;language:string})=>void|Dispose):Dispose};
 theme:{get():{mode:string;tokens:Record<string,string>};addStyle(css:string):Dispose};
 assets:{url(name:string):string};
 knowledge:{
  list(input?:{limit?:number}):Promise<NoteSummary[]>;search(query:string,limit?:number):Promise<NoteSummary[]>;read(ref:NoteRef):Promise<NoteSnapshot>;
  create(input:{title:string;parentRelativePath?:string|null;content?:string}):Promise<NoteSnapshot>;
  append(ref:NoteRef,content:string,expectedRevision?:string|null):Promise<NoteMutation>;
  insert(ref:NoteRef,offset:number,text:string,expectedRevision?:string|null):Promise<NoteMutation>;
  replace(ref:NoteRef,content:string,expectedRevision?:string|null):Promise<NoteMutation>;
  move(ref:NoteRef,title:string,expectedRevision:string,parentRelativePath?:string|null):Promise<NoteSnapshot>;
  delete(ref:NoteRef,expectedRevision:string):Promise<void>;
  context():Promise<unknown>;index():Promise<unknown>;backlinks(ref:NoteRef):Promise<unknown>;tags():Promise<unknown>;
 };
 /** Same explicit target/revision rules as the host. Use a frozen library ID for async operations. */
 materials:{
  library(libraryId:string):{
   listAssets():Promise<unknown[]>;getAssetsByIds(ids:string[]):Promise<unknown[]>;listFolders(scope:'materials'):Promise<unknown[]>;
   importAssets(options?:{folderId?:string|null;paths?:string[];storageMode?:'managed'|'linked'|'source';managedLibraryDir?:string|null}):Promise<unknown>;
   updateAsset(id:string,patch:{name?:string;description?:string;rating?:number|null;dominantColor?:string|null}):Promise<unknown>;
   deleteAsset(id:string,options?:{deleteFile?:boolean}):Promise<void>;listTags():Promise<unknown[]>;setAssetTags(id:string,tags:string[]):Promise<string[]>;moveAssetToFolder(input:{assetId:string;folderId:string|null}):Promise<void>;
  };
  list():Promise<unknown[]>;readMany(ids:string[]):Promise<unknown[]>;query(filter:Record<string,unknown>):Promise<unknown[]>;
  importFiles(folderId?:string|null,options?:{paths?:string[];libraryId?:string|null;storageMode?:'managed'|'linked'|'source';managedLibraryDir?:string|null}):Promise<unknown>;
  importFolder(path:string,options?:Record<string,unknown>,libraryId?:string|null):Promise<unknown>;
  update(id:string,patch:Record<string,unknown>,vaultId?:string,libraryId?:string|null):Promise<unknown>;
  rename(id:string,name:string,vaultId?:string,libraryId?:string|null):Promise<unknown>;
  delete(id:string,options?:{deleteFile?:boolean},vaultId?:string,libraryId?:string|null):Promise<void>;
  tags():Promise<unknown[]>;setTags(id:string,tags:string[],vaultId?:string,libraryId?:string|null):Promise<string[]>;
  move(ids:string[],folderId:string|null,libraryId?:string|null):Promise<PromiseSettledResult<void>[]>;libraries():unknown;
 };
 canvas:{list():Promise<CanvasEntry[]>;read(id:string):Promise<CanvasDocument>;create(name:string):Promise<CanvasEntry>;save(document:CanvasDocument):Promise<CanvasEntry>;rename(id:string,name:string,revision:number,digest:string):Promise<CanvasEntry>;delete(id:string,revision:number,digest:string):Promise<void>};
 storage:{read():Promise<ExtensionData>;write(data:ExtensionData):Promise<void>};
 /** Older API 2 hosts pass only the payload; check context before scoped writes. */
 events:{on<T>(name:string,handler:(payload:T,context?:DesktopEventWriteContext)=>void|Promise<void>):Promise<Dispose>};
 ai:{generate(prompt:string,options?:{signal?:AbortSignal;onChunk?:(text:string)=>void}):Promise<{text:string}>};
 network:{request(input:{url:string;method?:string;headers?:Record<string,string>;body?:string;timeoutMs?:number},signal?:AbortSignal):Promise<{status:number;headers:Record<string,string>;body:string}>};
 files:{read(path:string):Promise<{base64:string}>;write(path:string,base64:string,options?:{overwrite?:boolean}):Promise<void>;list(path:string):Promise<{name:string;directory:boolean}[]>;mkdir(path:string):Promise<void>;rename(from:string,to:string):Promise<void>;remove(path:string):Promise<void>};
 process:{spawn(input:{executable:string;args?:string[];cwd:string;env?:Record<string,string>}):Promise<ProcessHandle>};
}
export interface DesktopExtensionModule {activate(api:DesktopExtensionApi):void|Dispose|Promise<void|Dispose>;deactivate?():void|Promise<void>}
