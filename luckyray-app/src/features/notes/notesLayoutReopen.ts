import type { KnowledgeDocument } from './documentSource';
import type { NotesLayoutSnapshot, NotesOpenTab } from './notesPaneModel';

export function savedNoteRelativePath(tab: NotesOpenTab): string | null {
  if (tab.kind === 'empty') return null;
  if (!tab.id.startsWith('real-vault:')) throw Error('旧布局包含已停用的笔记身份，请重新保存布局。');
  const path=tab.id.slice('real-vault:'.length);
  if(!path||path.length>2048||/[\\\0:]/.test(path)||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||!path.toLowerCase().endsWith('.md'))throw Error('布局包含无效笔记路径，当前内容保持不变。');
  return path;
}
export function canReopenSavedNote(tab:NotesOpenTab):boolean{
  try{return tab.kind==='empty'?/^empty-[\w-]{1,120}$/.test(tab.id):Boolean(savedNoteRelativePath(tab));}catch{return false;}
}

/** Read every closed/unloaded identity before moving a live view. No writes,
 * source switch, draft replacement, or partial-layout success is possible. */
export async function preloadNotesLayout(
 saved:NotesLayoutSnapshot,
 isLoaded:(tab:NotesOpenTab)=>boolean,
 read:(relativePath:string)=>Promise<KnowledgeDocument>,
 isCurrent:()=>boolean,
):Promise<Map<string,KnowledgeDocument>>{
 const tabs=new Map(Object.values(saved.state.tabs).flat().map(tab=>[tab.id,tab]));
 if(tabs.size>500)throw Error('布局中的笔记过多，当前内容保持不变。');
 const prepared=new Map<string,KnowledgeDocument>();const missing:string[]=[];
 for(const tab of tabs.values()){
  if(!isCurrent())throw Error('知识库或当前布局已变化，请重新应用布局。');
  if(tab.kind==='empty'||isLoaded(tab))continue;
  const path=savedNoteRelativePath(tab)!;
  try{
   const document=await read(path);
   if(!isCurrent())throw Error('notes-layout-context-changed');
   if(document.relativePath!==path||document.source!=='real-vault')throw Error('notes-layout-document-identity');
   prepared.set(tab.id,document);
  }catch(error){
   if(!isCurrent())throw Error('知识库或当前布局已变化，请重新应用布局。');
   missing.push(path);
  }
 }
 if(missing.length)throw Error(`布局未应用：${missing.slice(0,5).join('、')}${missing.length>5?` 等 ${missing.length} 个文件`:''} 不存在或无法读取。当前标签和草稿保持不变。`);
 return prepared;
}
