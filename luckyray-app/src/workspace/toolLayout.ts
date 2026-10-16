export type ToolKind='outline'|'backlinks'|'material-inspector'|'material-filter';
export type ToolDock='left'|'right'|'bottom'|'float';
export type ToolPanel={kind:ToolKind;dock:ToolDock;pin:{viewId:string;objectId?:string}|null};
export type ToolLayout={panels:ToolPanel[];active:Partial<Record<ToolDock,ToolKind>>;sizes:{left:number;right:number;bottom:number};floating:{x:number;y:number;width:number;height:number}};
export const toolNames:Record<ToolKind,string>={outline:'笔记大纲',backlinks:'反向链接','material-inspector':'素材检查器','material-filter':'素材筛选'};
export const toolDocks:ToolDock[]=['left','right','bottom','float'];
export function emptyTools():ToolLayout{return {panels:[],active:{},sizes:{left:260,right:300,bottom:230},floating:{x:40,y:40,width:320,height:400}};}
export function decodeTools(value:unknown):ToolLayout|null{
 if(value===undefined)return emptyTools();if(!value||typeof value!=='object')return null;
 const v=value as ToolLayout;if(!Array.isArray(v.panels)||v.panels.length>4||!v.active||!v.sizes||!v.floating)return null;
 const kinds=new Set<ToolKind>();const panels:ToolPanel[]=[];
 for(const item of v.panels){
  if(!item||!Object.prototype.hasOwnProperty.call(toolNames,item.kind)||kinds.has(item.kind)||!toolDocks.includes(item.dock))return null;
  kinds.add(item.kind);let pin:ToolPanel['pin']=null;
  if(item.pin!==null){if(!item.pin||typeof item.pin.viewId!=='string'||!item.pin.viewId||item.pin.viewId.length>4096||item.pin.objectId!==undefined&&(typeof item.pin.objectId!=='string'||item.pin.objectId.length>4096))return null;pin={viewId:item.pin.viewId,...(item.pin.objectId===undefined?{}:{objectId:item.pin.objectId})};}
  panels.push({kind:item.kind,dock:item.dock,pin});
 }
 const active:ToolLayout['active']={};for(const dock of toolDocks){const kind=v.active[dock];if(kind!==undefined&&!panels.some(p=>p.kind===kind&&p.dock===dock))return null;if(kind)active[dock]=kind;}
 const n=(value:unknown,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
 if(!n(v.sizes.left,180,800)||!n(v.sizes.right,180,800)||!n(v.sizes.bottom,140,800)||!n(v.floating.x,0,10000)||!n(v.floating.y,0,10000)||!n(v.floating.width,220,1600)||!n(v.floating.height,180,1200))return null;
 return {panels,active,sizes:{left:v.sizes.left,right:v.sizes.right,bottom:v.sizes.bottom},floating:{x:v.floating.x,y:v.floating.y,width:v.floating.width,height:v.floating.height}};
}
export function moveTool(layout:ToolLayout,kind:ToolKind,dock:ToolDock):ToolLayout{
 const current=layout.panels.find(p=>p.kind===kind);const panels=[...layout.panels.filter(p=>p.kind!==kind),{kind,dock,pin:current?.pin??null}];
 return normalizeTools({...layout,panels,active:{...layout.active,[dock]:kind}});
}
export function closeTool(layout:ToolLayout,kind:ToolKind):ToolLayout{return normalizeTools({...layout,panels:layout.panels.filter(p=>p.kind!==kind)});}
function normalizeTools(layout:ToolLayout){const active:ToolLayout['active']={};for(const dock of toolDocks){const panels=layout.panels.filter(p=>p.dock===dock);const kind=panels.find(p=>p.kind===layout.active[dock])?.kind??panels[0]?.kind;if(kind)active[dock]=kind;}return {...layout,active};}
