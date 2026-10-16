import {decodePresentation, type WorkspacePresentation} from './presentation';
import type {IntegratedLayouts} from './integratedLayoutRegistry';
import type {LayoutStorage} from './layoutStore';
export type IntegratedPreset = {id:string;name:string;savedAt:string;route:string;presentation:WorkspacePresentation;pages:IntegratedLayouts};
const KEY='luckyray-integrated-layouts-v1';
const routes=['materials','attachments','notes','graph','canvas','browser','community','ai','tags','collection','favorites','smart','settings','plugins'];
function decode(value:unknown):IntegratedPreset|null {
  if(!value || typeof value!=='object') return null;
  const row=value as IntegratedPreset, presentation=decodePresentation(row.presentation);
  if(typeof row.id!=='string'||!row.id||row.id.length>128||typeof row.name!=='string'||!row.name.trim()||row.name.length>64||typeof row.savedAt!=='string'||!Number.isFinite(Date.parse(row.savedAt))||!routes.includes(row.route)||!presentation||!row.pages||typeof row.pages!=='object'||Array.isArray(row.pages)||Object.keys(row.pages).some(key=>key!=='notes'&&key!=='graph'))return null;
  // Each preset owns its snapshot, including the value returned from save().
  // Page providers may retain and mutate the objects they supplied afterwards.
  return {id:row.id,name:row.name,savedAt:row.savedAt,route:row.route,presentation,pages:JSON.parse(JSON.stringify(row.pages)) as IntegratedLayouts};
}
/** Separate schema: never overwrite existing trial-workspace recovery/presets. */
export class IntegratedPresets {
  private storage:LayoutStorage;
  constructor(storage:LayoutStorage){this.storage=storage;}
  list():IntegratedPreset[]{
    const raw=this.storage.getItem(KEY);if(!raw)return [];
    if(raw.length>2_000_000)throw Error('布局数据过大，原数据保持不变。');
    const rows:unknown=JSON.parse(raw);
    if(!Array.isArray(rows)||rows.length>24)throw Error('无法读取已保存布局，原数据保持不变。');
    const result=rows.map(decode);
    if(result.some(row=>!row)||new Set(result.map(row=>row!.id)).size!==rows.length||new Set(result.map(row=>row!.name.toLocaleLowerCase())).size!==rows.length)throw Error('已保存布局无效，原数据保持不变。');
    return result as IntegratedPreset[];
  }
  save(value:Omit<IntegratedPreset,'id'|'savedAt'>,replaceId?:string){
    const rows=this.list();
    if(replaceId&&!rows.some(row=>row.id===replaceId))throw Error('原布局已不存在。');
    const row=decode({...value,name:value.name.trim(),id:replaceId??crypto.randomUUID(),savedAt:new Date().toISOString()});
    if(!value.name.trim()||value.name.trim().length>64)throw Error('请输入 1–64 字的布局名称。');
    if(!row)throw Error('当前页面或布局数据不受支持，未保存。');
    if(rows.some(other=>other.id!==row.id&&other.name.toLocaleLowerCase()===row.name.toLocaleLowerCase()))throw Error('已有同名布局，请改名或选择更新此布局。');
    if(!replaceId&&rows.length>=24)throw Error('最多保存 24 个布局，请先移除旧布局。');
    const next=JSON.stringify(replaceId?rows.map(other=>other.id===replaceId?row:other):[...rows,row]);
    if(next.length>2_000_000)throw Error('布局数据过大，未保存。');
    this.storage.setItem(KEY,next);return row;
  }
  remove(id:string){this.storage.setItem(KEY,JSON.stringify(this.list().filter(row=>row.id!==id)));}
}
