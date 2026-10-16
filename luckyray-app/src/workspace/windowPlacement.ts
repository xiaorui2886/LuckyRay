/** Physical monitor geometry, logical window size. No document bodies or paths. */
export type WorkArea={x:number;y:number;width:number;height:number;scale:number;name:string|null};
export type WindowPlacement={x:number;y:number;width:number;height:number;scale:number;monitor:string|null;maximized:boolean};
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
export function decodePlacement(value:unknown):WindowPlacement|null{
 if(!value||typeof value!=='object')return null;const v=value as Record<string,unknown>;
 if(![v.x,v.y,v.width,v.height,v.scale].every(finite)||Math.abs(v.x as number)>1e6||Math.abs(v.y as number)>1e6||(v.width as number)<100||(v.width as number)>30000||(v.height as number)<100||(v.height as number)>30000||(v.scale as number)<.5||(v.scale as number)>8)return null;
 if(v.monitor!==null&&typeof v.monitor!=='string')return null;if(typeof v.maximized!=='boolean')return null;
 return {x:v.x as number,y:v.y as number,width:v.width as number,height:v.height as number,scale:v.scale as number,monitor:v.monitor as string|null,maximized:v.maximized};
}
export function recoverPlacement(saved:WindowPlacement,monitors:WorkArea[]):WindowPlacement|null{
 const areas=monitors.filter(m=>[m.x,m.y,m.width,m.height,m.scale].every(finite)&&m.width>0&&m.height>0&&m.scale>=.5&&m.scale<=8);
 if(!areas.length)return null;
 const overlap=(m:WorkArea)=>Math.max(0,Math.min(saved.x+saved.width*saved.scale,m.x+m.width)-Math.max(saved.x,m.x))*Math.max(0,Math.min(saved.y+saved.height*saved.scale,m.y+m.height)-Math.max(saved.y,m.y));
 const same=saved.monitor?areas.find(m=>m.name===saved.monitor):undefined;
 const target=same??areas.reduce((a,b)=>overlap(b)>overlap(a)?b:a);
 // Preserve logical reading size across DPI changes, but fit the visible work area.
 const width=Math.min(Math.max(480,saved.width),target.width/target.scale);
 const height=Math.min(Math.max(360,saved.height),target.height/target.scale);
 const onscreen=overlap(target)>0;
 const x=onscreen?saved.x:target.x+(target.width-width*target.scale)/2;
 const y=onscreen?saved.y:target.y+(target.height-height*target.scale)/2;
 return {x:Math.round(Math.max(target.x,Math.min(x,target.x+target.width-width*target.scale))),y:Math.round(Math.max(target.y,Math.min(y,target.y+target.height-height*target.scale))),width,height,scale:target.scale,monitor:target.name,maximized:saved.maximized};
}
