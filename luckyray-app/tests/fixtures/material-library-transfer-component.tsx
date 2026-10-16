// Production components/CSS with an explicit transport fixture, never a user profile.
import { createRoot } from "react-dom/client";
import { MaterialLibrarySwitcher } from "../../src/features/materials/MaterialLibrarySwitcher";
import { MaterialLibraryTransferUI } from "../../src/features/materials/MaterialLibraryTransferUI";
import { materialLibrarySession, type MaterialLibraryRegistry } from "../../src/core/services/materialLibraryContext";
import { materialLibraryTransfers, requestMaterialLibraryCopy, type MaterialTransferTask } from "../../src/core/services/materialLibraryTransfers";
import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore } from "../../src/app/applicationModalIsolation";
import "../../src/features/materials/materials.css";
import "../../src/core/theme/themeTokens.css";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") || "light";
const A = "library-default-000001", B = "library-second-000002";
const registry: MaterialLibraryRegistry = { legacyId: A, activeId: A, libraries: [A,B].map((id,index) => ({ id, name: index ? "项目参考" : "设计素材", rootPath: index ? "D:/项目参考" : null, storageMode: "managed", state: "ready", visible: true, version: 0, preferences: {} })) };
const tasks = new Map<string, MaterialTransferTask>(); const commands: unknown[] = [];
const changes: string[] = [];
window.addEventListener("luckyray:material-library-change", event => { changes.push((event as CustomEvent).detail.libraryId); });
function seedHistory(owner: string, count: number) {
  for (let i = 0; i < count; i++) {
    const id = `history-${owner}-${i}`;
    tasks.set(id, { taskId: id, sourceLibraryId: owner, targetLibraryId: owner === A ? B : A, sourceName: owner === A ? "设计素材" : "项目参考", targetName: "历史目标", kind: "copy", phase: "completed", currentFile: null, currentBytes: 0, currentTotalBytes: 0, total: 1, completed: 1, copied: 1, skipped: 0, failed: 0, items: [], error: null, outputPath: null, retryable: false });
  }
}
if (new URLSearchParams(location.search).has("restart")) {
  registry.activeId = B; registry.libraries[0].visible = false; registry.libraries[0].state = "offline";
  seedHistory(A, 1); seedHistory(B, 20);
  tasks.set("restart-unresolved-A", { ...tasks.get(`history-${A}-0`)!, taskId: "restart-unresolved-A", phase: "interrupted", retryable: true, copied: 0, error: "上次任务中断；可从冻结记录重试" });
}
let heldSave: ((v: string) => void) | null = null; let pauseSave = false;
const fixture = {
  commands,
  changes,
  snapshot: () => structuredClone(materialLibraryTransfers.getSnapshot()),
  seedHistory: (owner: string, count = 20) => { seedHistory(owner, count); },
  pauseSave: () => { pauseSave = true; },
  resolveSave: () => { heldSave?.("D:/fixture/设计素材.lrlibrary"); heldSave = null; pauseSave = false; },
  select: (id: string) => materialLibrarySession.select(id),
  complete: (id: string, phase = "completed") => {
    const task = tasks.get(id)!; task.phase = phase; task.completed = task.total;
    task.failed = phase === "failed" ? task.total : 0; task.copied = phase === "completed" ? task.total : 0;
    task.error = phase === "failed" ? "原文件已离线，请连接后按原目标重试" : null; task.retryable = phase !== "completed";
    task.items.forEach(item => { item.state = phase === "completed" ? "copied" : "failed"; item.error = task.error; });
    if (task.kind === "restore" && phase === "completed") registry.libraries.push({ id: task.targetLibraryId!, name: task.targetName!, rootPath: "D:/fixture/restored", storageMode: "managed", state: "ready", visible: true, version: 0, preferences: {} });
  },
  taskIds: () => [...tasks.keys()],
  seedLongTasks: () => {
    for (let i=0;i<16;i++) {
      const id = `long-task-${i}`; tasks.set(id,{taskId:id,sourceLibraryId:A,targetLibraryId:B,sourceName:"很长的中文素材库名称".repeat(6),targetName:"项目参考库".repeat(8),kind:i%2?"copy":"export",phase:i%2?"failed":"interrupted",currentFile:null,currentBytes:0,currentTotalBytes:0,total:200,completed:200,copied:0,skipped:0,failed:200,items:Array.from({length:200},(_,n)=>({assetId:`asset-${n}`,name:"很长的文件名称".repeat(10)+".png",state:"failed",targetAssetId:null,error:"原文件离线，请重新连接源目录。".repeat(10)})),error:"部分原文件缺失或离线；完整备份未生成。".repeat(10),outputPath:"D:/"+"很长的备份目录/".repeat(30)+"archive.lrlibrary",retryable:true});
    }
    return materialLibraryTransfers.load(A);
  },
};
(window as any).__MATERIAL_TRANSFER_FIXTURE__ = fixture;
(window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  if (command === "plugin:dialog|open") return args.options.directory ? "D:/fixture/restored" : "D:/fixture/archive.lrlibrary";
  if (command === "plugin:dialog|save") return pauseSave ? new Promise<string>(resolve => { heldSave = resolve; }) : "D:/fixture/设计素材.lrlibrary";
  if (command !== "material_library_command") throw new Error("Unexpected fixture command: " + command);
  const { libraryId, action } = args.request; commands.push(structuredClone(args.request));
  if (action.op === "registry") return structuredClone({ ...registry, libraries: registry.libraries.filter(l => action.include_hidden || l.visible) });
  if (action.op === "select") { registry.activeId = libraryId; return null; }
  if (action.op === "transferList") {
    const owned = [...tasks.values()].filter(t => t.sourceLibraryId === libraryId).reverse();
    return structuredClone([...owned.filter(t => t.phase !== "completed"), ...(!action.unresolvedOnly ? owned.filter(t => t.phase === "completed").slice(0, 16) : [])]);
  }
  if (["transferCopy","transferExport","transferRestore"].includes(action.op)) {
    const kind = action.op === "transferCopy" ? "copy" : action.op === "transferExport" ? "export" : "restore";
    const task: MaterialTransferTask = { taskId:action.requestId,sourceLibraryId:libraryId,targetLibraryId:kind==="copy"?action.targetLibraryId:kind==="restore"?"library-restored-000004":null,sourceName:kind==="restore"?"archive.lrlibrary":registry.libraries.find(l=>l.id===libraryId)!.name,targetName:kind==="copy"?registry.libraries.find(l=>l.id===action.targetLibraryId)!.name:kind==="restore"?action.name:null,kind,phase:"staging",currentFile:"主图.png",currentBytes:1048576,currentTotalBytes:4194304,total:1,completed:0,copied:0,skipped:0,failed:0,items:[{assetId:"source-asset",name:"主图.png",state:"pending",targetAssetId:null,error:null}],error:null,outputPath:action.destination??null,retryable:true };
    tasks.set(task.taskId,task); return structuredClone(task);
  }
  const task = tasks.get(action.taskId); if (!task || task.sourceLibraryId !== libraryId) throw new Error("任务身份不匹配");
  if (action.op === "transferCancel") { task.phase="cancelled"; task.error="已取消"; task.items.forEach(i=>i.state="cancelled"); }
  if (action.op === "transferRetry") { task.phase="staging"; task.error=null; task.completed=0; task.failed=0; task.items.forEach(i=>{i.state="pending";i.error=null;}); }
  return structuredClone(task);
} };
await materialLibrarySession.initialize();
createRoot(document.getElementById("root")!).render(<ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}><main className="materials-page"><MaterialLibrarySwitcher/><MaterialLibraryTransferUI/><div className="material-transfer-selection"><button type="button" onClick={()=>requestMaterialLibraryCopy({libraryId:materialLibrarySession.getSnapshot().libraryId!,selection:{assetIds:["source-asset"]},label:"已选 1 项"})}>复制所选素材到其他库</button></div></main></ApplicationModalIsolationProvider>);
