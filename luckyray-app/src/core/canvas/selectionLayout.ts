import {canvasNodeSize, type CanvasArrangementNode} from './canvasArrangement';
export type LayoutCommand = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom' | 'distributeX' | 'distributeY';
export type LayoutPlan = {positions: Map<string,{x:number;y:number}>;changed:boolean};
/** A group is one layout unit; selected descendants never move twice. */
export function selectedLayoutRoots<T extends CanvasArrangementNode>(nodes: readonly T[], ids: readonly string[]): T[] | null {
 const wanted=new Set(ids),byId=new Map(nodes.map(n=>[n.id,n]));
 if(!wanted.size || [...wanted].some(id=>!byId.has(id)))return null;
 const roots:T[]=[];
 for(const node of nodes){if(!wanted.has(node.id))continue;if(!Number.isFinite(node.position.x)||!Number.isFinite(node.position.y))return null;
  let parent=node.parentId,covered=false;const seen=new Set([node.id]);
  while(parent){if(seen.has(parent)||!byId.has(parent))return null;seen.add(parent);if(wanted.has(parent))covered=true;parent=byId.get(parent)?.parentId;}
  if(!covered)roots.push(node);
 }
 return roots;
}
export function canLayoutSelection(nodes: readonly CanvasArrangementNode[],ids:readonly string[]){const roots=selectedLayoutRoots(nodes,ids);return !!roots&&roots.length>=2&&new Set(roots.map(n=>n.parentId||null)).size===1;}
function limits(node:CanvasArrangementNode,byId:Map<string,CanvasArrangementNode>){
 const size=canvasNodeSize(node);
 if(node.extent==='parent'&&node.parentId){const parent=byId.get(node.parentId);if(!parent)return null;const p=canvasNodeSize(parent);return {left:0,top:0,right:p.width-size.width,bottom:p.height-size.height};}
 if(Array.isArray(node.extent)&&node.extent.length===2){const [[left,top],[right,bottom]]=node.extent as number[][];if(![left,top,right,bottom].every(Number.isFinite))return null;return {left,top,right:right-size.width,bottom:bottom-size.height};}
 return {left:-Infinity,top:-Infinity,right:Infinity,bottom:Infinity};
}
export function planSelectionLayout(nodes:readonly CanvasArrangementNode[],ids:readonly string[],command:LayoutCommand):LayoutPlan|null{
 if(!canLayoutSelection(nodes,ids))return null;
 const roots=selectedLayoutRoots(nodes,ids)!,horizontal=['left','centerX','right','distributeX'].includes(command),axis=horizontal?'x':'y',sizeKey=horizontal?'width':'height';
 const rows=roots.map(n=>({node:n,at:n.position[axis],size:canvasNodeSize(n)[sizeKey]}));
 const lo=Math.min(...rows.map(r=>r.at)),hi=Math.max(...rows.map(r=>r.at+r.size));
 const positions=new Map<string,{x:number;y:number}>();
 if(command==='distributeX'||command==='distributeY'){
  if(rows.length<3)return null;
  rows.sort((a,b)=>a.at-b.at||a.node.id.localeCompare(b.node.id));
  // Equal edge gaps, not equal origins: respect differing image dimensions.
  const gap=(hi-lo-rows.reduce((sum,r)=>sum+r.size,0))/(rows.length-1);let cursor=lo;
  for(const row of rows){positions.set(row.node.id,{...row.node.position,[axis]:cursor});cursor+=row.size+gap;}
 }else{
  for(const row of rows){const at=command==='left'||command==='top'?lo:command==='right'||command==='bottom'?hi-row.size:(lo+hi-row.size)/2;positions.set(row.node.id,{...row.node.position,[axis]:at});}
 }
 const byId=new Map(nodes.map(n=>[n.id,n]));
 for(const node of roots){const p=positions.get(node.id)!,b=limits(node,byId);if(!b||p.x<b.left-.001||p.x>b.right+.001||p.y<b.top-.001||p.y>b.bottom+.001)return null;}
 return {positions,changed:roots.some(n=>{const p=positions.get(n.id)!;return Math.abs(n.position.x-p.x)>.001||Math.abs(n.position.y-p.y)>.001;})};
}
export function planSelectionNudge(nodes:readonly CanvasArrangementNode[],ids:readonly string[],dx:number,dy:number):LayoutPlan|null{
 const roots=selectedLayoutRoots(nodes,ids);if(!roots?.length||![dx,dy].every(Number.isFinite))return null;
 const byId=new Map(nodes.map(n=>[n.id,n]));let minX=-Infinity,maxX=Infinity,minY=-Infinity,maxY=Infinity;
 for(const n of roots){const b=limits(n,byId);if(!b)return null;minX=Math.max(minX,b.left-n.position.x);maxX=Math.min(maxX,b.right-n.position.x);minY=Math.max(minY,b.top-n.position.y);maxY=Math.min(maxY,b.bottom-n.position.y);}
 if(minX>maxX||minY>maxY||minX>0||maxX<0||minY>0||maxY<0)return null;
 dx=Math.min(maxX,Math.max(minX,dx));dy=Math.min(maxY,Math.max(minY,dy));
 return {positions:new Map(roots.map(n=>[n.id,{x:n.position.x+dx,y:n.position.y+dy}])),changed:!!(dx||dy)};
}
export function applySelectionLayout<T extends CanvasArrangementNode>(nodes:readonly T[],plan:LayoutPlan):T[]{return nodes.map(n=>{const p=plan.positions.get(n.id);return p&&(n.position.x!==p.x||n.position.y!==p.y)?{...n,position:p}:n;});}
