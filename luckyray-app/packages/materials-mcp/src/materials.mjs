import {isIP} from 'node:net';
import {MaterialError} from './transport.mjs';
const fail=code=>{throw new MaterialError(code);};
function object(value,keys){if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!keys.includes(k)))fail('input-invalid');return value;}
function string(value,max=2048){if(typeof value!=='string'||!value.trim()||value.length>max)fail('input-invalid');return value;}
export function validateImport(input){
 object(input,['url','fileName','folderId','newFolderName']);const raw=string(input.url);let url;try{url=new URL(raw);}catch{fail('download-url-invalid');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443'))fail('download-url-denied');
 const host=url.hostname.toLowerCase();
 if(isIP(host)||host.includes(':')||!host.includes('.')||host==='localhost'||/\.(localhost|local|internal|test|invalid)$/.test(host))fail('download-url-denied');
 const fileName=string(input.fileName,120);
 if(fileName.startsWith('.')||fileName.trim()!==fileName||/[<>:"/\\|?*\x00-\x1f\x7f]/.test(fileName)||/[. ]$/.test(fileName)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(fileName)||fileName==='.'||fileName==='..')fail('filename-invalid');
 if(input.folderId&&input.newFolderName)fail('folder-input-conflict');
 const body={url:raw,fileName};if(input.folderId)body.folderId=string(input.folderId,256);
 if(input.newFolderName){const name=string(input.newFolderName,120);if(/[<>:"/\\|?*\x00-\x1f]/.test(name))fail('folder-input-invalid');body.newFolderName=name;}
 return body;
}
export function importOutcome(data){
 if(!data||typeof data.assetId!=='string'||!data.assetId||!['imported','duplicate'].includes(data.disposition)||typeof data.assetName!=='string'||typeof data.kind!=='string'||typeof data.libraryId!=='string'||!Number.isSafeInteger(data.sizeBytes)||data.sizeBytes<0)fail('import-receipt-invalid');
 return {assetId:data.assetId,assetName:data.assetName,libraryId:data.libraryId,kind:data.kind,sizeBytes:data.sizeBytes,disposition:data.disposition,folderId:data.folderId??null};
}
export class Materials {
 constructor(transport){this.transport=transport;}
 async run(name,args={}){
  switch(name){
   case 'connection_status':object(args,[]);return this.transport.status();
   case 'search_assets':{object(args,['query','limit']);if(args.query!==undefined&&typeof args.query!=='string')fail('input-invalid');const query=args.query??'',limit=args.limit??10;if(query.length>1000||!Number.isInteger(limit)||limit<1||limit>50)fail('input-invalid');const out=await this.transport.call('/api/v1/tools/run',{toolId:'materials.search',input:{query,limit}});if(!Array.isArray(out?.result?.assets))fail('response-invalid');return {assets:out.result.assets.map(a=>({assetId:a.id,name:a.name,kind:a.kind,mimeType:a.mimeType??null,folderId:a.folderId??null,sizeBytes:a.sizeBytes??null})),libraryId:this.transport.config?.libraryId??null};}
   case 'get_asset':{object(args,['assetId']);const assetId=string(args.assetId,256);const out=await this.transport.call('/api/v1/tools/run',{toolId:'materials.inspect',input:{assetId}});if(!out?.result)fail('response-invalid');const a=out.result.asset??out.result;if((a.assetId??a.id)!==assetId||typeof a.name!=='string'||typeof a.kind!=='string')fail('response-invalid');return {assetId:a.assetId??a.id,name:a.name,kind:a.kind,mimeType:a.mimeType??null,sizeBytes:a.sizeBytes??null,folderId:a.folderId??null};}
   case 'list_folders':object(args,[]);return this.transport.call('/api/v1/folders');
   case 'import_file':return importOutcome(await this.transport.call('/api/v1/assets/import-file',validateImport(args)));
   default:fail('tool-not-found');
  }
 }
}
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
export const TOOLS=[
 ['connection_status','Verify the explicitly selected desktop instance. No app startup.',schema({}),true],
 ['search_assets','Search the explicitly paired LuckyRay library. Does not follow the active UI library.',schema({query:{type:'string',maxLength:1000},limit:{type:'integer',minimum:1,maximum:50}}),true],
 ['get_asset','Read asset metadata by exact ID through the official inspect interface. Older versions may not support it.',schema({assetId:{type:'string'}},['assetId']),true],
 ['list_folders','Read folders in the explicitly paired library through the official endpoint.',schema({}),true],
 ['import_file','Import a public HTTPS file through LuckyRay official download, SHA-256 deduplication and Catalog pipeline. Returns confirmed assetId. ZIP is stored, never extracted. Local paths are not supported by this desktop endpoint. No automatic retry after an unknown outcome.',schema({url:{type:'string',format:'uri'},fileName:{type:'string',maxLength:120},folderId:{type:'string'},newFolderName:{type:'string'}},['url','fileName']),false],
].map(([name,description,inputSchema,readOnlyHint])=>({name,description,inputSchema,annotations:{readOnlyHint,destructiveHint:false,openWorldHint:!readOnlyHint}}));
