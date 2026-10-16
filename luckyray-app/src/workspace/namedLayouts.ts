import {decodeLayout,type WorkspaceLayout} from './layout';
import type {LayoutStorage} from './layoutStore';
export type NamedLayout={id:string;name:string;savedAt:string;layout:WorkspaceLayout};

/** Explicit presets are separate from automatic session recovery, and local to
 * this window. Only the strict identity/layout schema reaches persistence. */
export class NamedLayouts {
  readonly key:string;
  readonly windowId:string;
  private storage:LayoutStorage;
  constructor(windowId:string,storage:LayoutStorage){this.windowId=windowId;this.storage=storage;this.key=`luckyray-workspace-presets-v1:${windowId}`;}
  list():NamedLayout[]{
    const raw=this.storage.getItem(this.key);if(!raw)return [];
    if(raw.length>2_000_000)throw Error('已保存布局数据过大，原数据未改动。');
    const value:unknown=JSON.parse(raw);
    if(!Array.isArray(value)||value.length>24)throw Error('已保存布局无法读取，原数据未改动。');
    const ids=new Set<string>(),names=new Set<string>();
    return value.map(row=>{
      const layout=decodeLayout(row?.layout,this.windowId);
      if(!layout||typeof row.id!=='string'||!row.id||row.id.length>128||ids.has(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>64||names.has(row.name.toLocaleLowerCase())||typeof row.savedAt!=='string'||!Number.isFinite(Date.parse(row.savedAt)))throw Error('已保存布局无效，原数据未改动。');
      ids.add(row.id);names.add(row.name.toLocaleLowerCase());
      return {id:row.id,name:row.name,savedAt:row.savedAt,layout};
    });
  }
  save(name:string,value:unknown,replaceId?:string):NamedLayout{
    const layout=decodeLayout(value,this.windowId);name=name.trim();
    if(!layout||!name||name.length>64)throw Error('请输入 1–64 字的名称，并使用当前窗口的有效布局。');
    const current=this.list();
    if(replaceId&&!current.some(item=>item.id===replaceId))throw Error('原布局已不存在，请另存为新布局。');
    if(current.some(item=>item.id!==replaceId&&item.name.toLocaleLowerCase()===name.toLocaleLowerCase()))throw Error('已有同名布局，请改名或明确选择替换。');
    if(!replaceId&&current.length>=24)throw Error('最多保存 24 个布局，请先移除不再使用的布局。');
    const saved={id:replaceId??crypto.randomUUID(),name,savedAt:new Date().toISOString(),layout};
    const next=replaceId?current.map(item=>item.id===replaceId?saved:item):[...current,saved];
    this.storage.setItem(this.key,JSON.stringify(next));return saved;
  }
  remove(id:string){const next=this.list().filter(item=>item.id!==id);this.storage.setItem(this.key,JSON.stringify(next));}
}
