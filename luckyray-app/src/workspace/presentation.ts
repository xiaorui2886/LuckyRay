export type ControlOrder={order:string[];hidden:string[]};
export type WorkspacePresentation={navigation:{space:ControlOrder;filters:ControlOrder};toolbar:ControlOrder;materialsToolbar?:ControlOrder;navigationVisibilityVersion?:1};
export const spaceControls=['materials','notes','graph','canvas','community','ai'];
export const filterControls=['tags','collection','favorites','smart'];
export const materialsToolbarControls=['view','workview','filter','clear-filter','missing','import-folder','export'];
export const toolbarControls=['open-note','open-graph','open-materials','layouts','windows','tools'];
const defaults=(ids:string[]):ControlOrder=>({order:[...ids],hidden:[]});
export function defaultPresentation():WorkspacePresentation{return {navigation:{space:defaults(spaceControls),filters:defaults(filterControls)},toolbar:defaults(toolbarControls)};}
export function decodeOrder(value:unknown,known:string[]):ControlOrder|null{
 if(!value||typeof value!=='object')return null;const v=value as ControlOrder;
 if(!Array.isArray(v.order)||!Array.isArray(v.hidden)||v.order.length>100||v.hidden.length>100||[...v.order,...v.hidden].some(id=>typeof id!=='string'||id.length>128)||new Set(v.order).size!==v.order.length||new Set(v.hidden).size!==v.hidden.length)return null;
 const order=[...v.order.filter(id=>known.includes(id)),...known.filter(id=>!v.order.includes(id))];
 return {order,hidden:v.hidden.filter(id=>known.includes(id))};
}
export function decodePresentation(value:unknown):WorkspacePresentation|null{
 if(value===undefined)return defaultPresentation();if(!value||typeof value!=='object')return null;const v=value as WorkspacePresentation;
 const space=decodeOrder(v.navigation?.space,spaceControls),filters=decodeOrder(v.navigation?.filters,filterControls),toolbar=decodeOrder(v.toolbar,toolbarControls);
 const materialsToolbar=v.materialsToolbar===undefined?undefined:decodeOrder(v.materialsToolbar,materialsToolbarControls);
 if(v.navigationVisibilityVersion!==undefined&&v.navigationVisibilityVersion!==1)return null;
 return space&&filters&&toolbar&&materialsToolbar!==null?{navigation:{space,filters},toolbar,...(materialsToolbar?{materialsToolbar}:{}),...(v.navigationVisibilityVersion===1?{navigationVisibilityVersion:1 as const}:{})}:null;
}
export function arrangeControls<T extends {id:string}>(items:T[],config?:ControlOrder):T[]{
 const safe=config?decodeOrder(config,items.map(item=>item.id)):defaults(items.map(item=>item.id));
 return (safe??defaults(items.map(item=>item.id))).order.filter(id=>!safe?.hidden.includes(id)).flatMap(id=>{const item=items.find(item=>item.id===id);return item?[item]:[];});
}
export function reorderControl(config:ControlOrder,id:string,index:number):ControlOrder{
 if(!config.order.includes(id)||!Number.isFinite(index))return config;const order=config.order.filter(item=>item!==id);order.splice(Math.max(0,Math.min(order.length,Math.trunc(index))),0,id);return {...config,order};
}

/** Reorder the visible strip without erasing hidden or future controls. */
export function reorderVisibleControl(config:ControlOrder,id:string,index:number,visible:string[]):ControlOrder {
 if(!visible.includes(id)||!Number.isFinite(index))return config;
 const peers=visible.filter(value=>value!==id);
 const at=Math.max(0,Math.min(peers.length,Math.trunc(index)));
 const remaining=config.order.filter(value=>value!==id);
 const before=peers[at];
 const target=before?remaining.indexOf(before):peers.length?remaining.indexOf(peers[peers.length-1])+1:0;
 return reorderControl(config,id,target);
}
