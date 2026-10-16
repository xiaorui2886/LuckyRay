import {useEffect,useState} from 'react';
import {workspaceCommand} from './nativeClient';
type Backlink={sourceRef:{vaultId:string;relativePath:string};link:{line:number;target:string}};
export function BacklinksTool({viewId,child,revision}:{viewId:string;child:boolean;revision:string}){
 const [items,setItems]=useState<Backlink[]>([]);const [error,setError]=useState('');const [refresh,setRefresh]=useState(0);
 useEffect(()=>{let alive=true;setError('');void workspaceCommand<Backlink[]>({op:'backlinks',viewId}).then(items=>{if(alive)setItems(items);}).catch(error=>{if(alive)setError(String(error));});return()=>{alive=false;};},[viewId,child,revision,refresh]);
 return <div className="workspace-backlinks"><button onClick={()=>setRefresh(value=>value+1)}>刷新反向链接</button>{error?<p role="alert">{error}</p>:items.length?items.map((item,index)=><article key={`${item.sourceRef.relativePath}:${item.link.line}:${index}`}><strong>{item.sourceRef.relativePath}</strong><small>第 {item.link.line} 行 · {item.link.target}</small></article>):<p>此笔记暂无反向链接。</p>}</div>;
}
