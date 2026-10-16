import { forceSimulation } from 'd3-force';

/** D3's neutral area-filling initialization, with stable key ordering that does
 * not put early/connected records in the centre and later isolates outside. */
export function graphSeedPositions(nodes: ReadonlyArray<{id:number;key:string}>, _edges: ReadonlyArray<readonly [number,number]>, width:number,height:number) {
  const hash=(key:string)=>{let h=2166136261;for(const c of key)h=Math.imul(h^c.charCodeAt(0),16777619);h^=h>>>16;h=Math.imul(h,0x7feb352d);h^=h>>>15;return h>>>0;};
  const seed=nodes.map(n=>({id:n.id,key:n.key,x:NaN,y:NaN})).sort((a,b)=>hash(a.key)-hash(b.key)||a.key.localeCompare(b.key));
  forceSimulation(seed).stop();
  return new Map(seed.map(n=>[n.id,{x:n.x+width/2,y:n.y+height/2}]));
}

export function graphScreenRadius(radius: number, scale: number) {
  const linear = radius * Math.sqrt(scale) * 1.18;
  // Keep overview dots readable and hubs distinguishable, without enlarging
  // detailed nodes indefinitely or changing their world-space collision radius.
  const overview = Math.min(3, 1.2 + radius * 0.22);
  return Math.max(overview, linear <= 4 ? linear : 4 + 6 * (1 - Math.exp(-(linear - 4) / 10)));
}

export function graphEdgeDetail(scale: number) {
  const t = Math.max(0, Math.min(1, (scale - 0.15) / 1.2));
  return {alpha: 0.48 + 0.14 * t, width: 0.85 + 0.15 * t};
}
