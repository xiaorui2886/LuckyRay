import * as services from './materials';
import {getLuckyRayBridgeSync} from '../bridge/luckyRayBridge';
import {createMaterialLibraryAdapter} from './materialLibraryAdapter';
import {MaterialStore} from './materialStore';
import {toLegacyMaterialBridgeFilter,type MaterialCatalogAdapter} from './materialCatalog';
import {isMaterialChange} from './materialChangeProtocol';

/** Immutable view authority: never consult the subsequently selected library. */
export function createMaterialViewServices(libraryId:string){
 const adapter=()=>{
  const bridge=getLuckyRayBridgeSync();if(!bridge)throw Error('LuckyRay bridge is not ready');
  return createMaterialLibraryAdapter(bridge as MaterialCatalogAdapter,libraryId);
 };
 const store=new MaterialStore({libraryId,reads:{
  list:()=>adapter().listAssets(),
  filtered:filter=>{
   if(filter.scope==='note-attachments')return Promise.reject(Error('workspace-material-scope-mismatch'));
   return adapter().listAssetsFiltered(toLegacyMaterialBridgeFilter(filter));
  },
  folders:()=>adapter().listFolders('materials'),byIds:ids=>adapter().getAssetsByIds(ids),
  change:async()=>{const change=await adapter().getMaterialChangeState();return isMaterialChange(change)?change:null;},
 }});
 return {store,services:{
  updateMaterialAsset:(id:string,patch:services.MaterialAssetUpdate,vaultId?:string)=>services.updateMaterialAsset(id,patch,vaultId,libraryId),
  renameMaterialAsset:(id:string,name:string,vaultId?:string)=>services.renameMaterialAsset(id,name,vaultId,libraryId),
  renameMaterialAssetFile:(id:string,name:string,vaultId?:string)=>services.renameMaterialAssetFile(id,name,vaultId,libraryId),
  relocateMaterialAsset:(id:string,path:string,options?:Parameters<typeof services.relocateMaterialAsset>[2],vaultId?:string)=>services.relocateMaterialAsset(id,path,options,vaultId,libraryId),
  deleteMaterialAsset:(id:string,options?:{deleteFile?:boolean},vaultId?:string)=>services.deleteMaterialAsset(id,options,vaultId,libraryId),
  createMaterialTag:(name:string,vaultId?:string)=>services.createMaterialTag(name,vaultId,libraryId),
  getMaterialAssetTagContext:(ids:string[],vaultId?:string)=>services.getMaterialAssetTagContext(ids,vaultId,libraryId),
  setMaterialAssetTags:(id:string,tags:string[],vaultId?:string)=>services.setMaterialAssetTags(id,tags,vaultId,libraryId),
  applyMaterialAssetTags:(ids:string[],tags:string[],vaultId?:string)=>services.applyMaterialAssetTags(ids,tags,vaultId,libraryId),
  moveMaterialAssetsToFolder:(ids:string[],folder:string|null)=>services.moveMaterialAssetsToFolder(ids,folder,libraryId),
  exportMaterialAssetFile:(asset:Parameters<typeof services.exportMaterialAssetFile>[0],vaultId?:string)=>services.exportMaterialAssetFile(asset,vaultId,libraryId),
  getMaterialSourcePage:(id:string,vaultId?:string)=>services.getMaterialSourcePage(id,vaultId,libraryId),
  scanMissingMaterialAssets:()=>services.scanMissingMaterialAssets(libraryId),
  removeMissingMaterialAssetRecord:(id:string)=>services.removeMissingMaterialAssetRecord(id,libraryId),
  getMaterialAssetAiSuggestion:(id:string,vaultId?:string)=>services.getMaterialAssetAiSuggestion(id,vaultId,libraryId),
  generateMaterialAssetAiSuggestion:(id:string,vaultId?:string)=>services.generateMaterialAssetAiSuggestion(id,vaultId,libraryId),
  dismissMaterialAssetAiSuggestion:(id:string,vaultId?:string)=>services.dismissMaterialAssetAiSuggestion(id,vaultId,libraryId),
  applyMaterialAssetAiTags:(id:string,names:string[],vaultId?:string)=>services.applyMaterialAssetAiTags(id,names,vaultId,libraryId),
  importSelectedMaterialFolder:async()=>{const path=await services.selectMaterialImportFolder();return path?services.importMaterialFolder(path,undefined,libraryId):null;},
 }};
}
