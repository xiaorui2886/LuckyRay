export type SurfaceRect={x:number;y:number;width:number;height:number};
export type SurfacePlacement={x:number;y:number;width:number;maxHeight:number;side:'top'|'bottom';visible:boolean};
/** Screen-space surfaces stay readable independently of camera zoom. */
export function placeCanvasSurface(node:SurfaceRect,stage:{width:number;height:number},surface:{width:number;height:number},preferred:'top'|'bottom'='bottom',gap=12,reserveToolbar=false,allowFlip=true):SurfacePlacement{
 if(![node.x,node.y,node.width,node.height,stage.width,stage.height,surface.width,surface.height,gap].every(Number.isFinite))return {x:12,y:76,width:0,maxHeight:0,side:preferred,visible:false};
 const margin=12,leftMargin=stage.width>=600?72:12,top=reserveToolbar?128:76,bottom=56;
 const width=Math.max(0,Math.min(surface.width,stage.width-leftMargin-margin));
 const available=Math.max(0,stage.height-top-bottom);
 const height=Math.min(surface.height,available);
 const visible=[node.x,node.y,node.width,node.height,stage.width,stage.height].every(Number.isFinite)&&node.width>0&&node.height>0&&available>=40&&width>=80&&node.x+node.width>0&&node.y+node.height>0&&node.x<stage.width&&node.y<stage.height;
 const x=Math.max(leftMargin,Math.min(stage.width-width-margin,node.x+(node.width-width)/2));
 const above=node.y-gap-height-(reserveToolbar?52:0),below=Math.max(top,node.y+node.height+gap);
 const fitTop=above>=top,fitBottom=below+height<=stage.height-bottom;
 const side=!allowFlip?preferred:preferred==='top'?(fitTop||!fitBottom?'top':'bottom'):(fitBottom||!fitTop?'bottom':'top');
 const desired=reserveToolbar&&!fitTop&&!fitBottom?stage.height-bottom-height:side==='top'?above:below;
 const y=Math.max(top,Math.min(stage.height-bottom-height,desired));
 return {x,y,width,maxHeight:available,side,visible};
}
