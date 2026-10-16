/** Snapshots are presentation caches, never proof that a referenced record exists. */
export function parseCanvasReference(value: unknown): {kind:'asset'|'note';id:string}|null {
 if(typeof value!=='string'||/[\u0000-\u001f\u007f]/.test(value))return null;
 const at=value.indexOf(':');if(at<0)return null;
 const kind=value.slice(0,at),id=value.slice(at+1).trim();
 if((kind!=='asset'&&kind!=='note')||!id||/[\u0000-\u001f\u007f]/.test(id))return null;
 return {kind,id};
}
export function hasInvalidCanvasReference(data:{kind:string;payload?:string;_emptyMedia?:boolean;refMediaUrl?:string|null;refThumbnailUrl?:string|null}):boolean {
 if(!['image','video','noteRef'].includes(data.kind)||data._emptyMedia)return false;
 const ref=parseCanvasReference(data.payload);
 if(ref)return ref.kind!==(data.kind==='noteRef'?'note':'asset');
 // Generated media can be valid without a material-catalog identity.
 if(data.kind!=='noteRef'&&(data.refMediaUrl||data.refThumbnailUrl)&&!data.payload)return false;
 return true;
}
