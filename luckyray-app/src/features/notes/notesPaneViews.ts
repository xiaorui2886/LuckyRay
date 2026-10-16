import { notesPaneIds, type NotesOpenTab, type NotesPaneLayout, type NotesPaneTabs } from './notesPaneModel';

/** Stable identity belongs to an open view, not its position or document.
 * Duplicate views of one document keep independent selection/media/search. */
export class NotesPaneViews {
  private sequence = 0;
  private owners = new Map<string, string>();
  private key(paneId: string, tabId: string) { return JSON.stringify([paneId, tabId]); }
  get(paneId: string, tabId: string) {
    const key = this.key(paneId, tabId);
    let id = this.owners.get(key);
    if (!id) { id = `notes-view-${++this.sequence}`; this.owners.set(key, id); }
    return id;
  }
  /** Admit a backend-created target identity only into an unused new slot. */
  adopt(paneId:string,tabId:string,viewId:string){
    const key=this.key(paneId,tabId);
    if(!viewId||viewId.length>128||this.owners.has(key)||[...this.owners.values()].includes(viewId))throw new Error('Incoming note view identity is already owned');
    this.owners.set(key,viewId);
    const local=/^notes-view-(\d+)$/.exec(viewId),sequence=local?Number(local[1]):0;
    if(Number.isSafeInteger(sequence))this.sequence=Math.max(this.sequence,sequence);
    return viewId;
  }
  move(sourcePaneId: string, tabId: string, targetPaneId: string) {
    if (sourcePaneId === targetPaneId) return;
    const id = this.get(sourcePaneId, tabId);
    this.owners.delete(this.key(sourcePaneId, tabId));
    this.owners.set(this.key(targetPaneId, tabId), id);
  }
  remapPane(sourcePaneId: string, targetPaneId: string, tabs: NotesOpenTab[]) {
    for (const tab of tabs) this.move(sourcePaneId, tab.id, targetPaneId);
  }
  arrange(previous: NotesPaneTabs, next: NotesPaneTabs) {
    const available = Object.entries(previous).flatMap(([paneId, tabs]) => tabs.map(tab => ({ paneId, tabId: tab.id, id: this.get(paneId, tab.id) })));
    const used = new Set<string>();
    const assignments = new Map<string, string>();
    for (const [paneId, tabs] of Object.entries(next)) for (const tab of tabs) {
      const existing = available.find(view => !used.has(view.id) && view.paneId === paneId && view.tabId === tab.id)
        || available.find(view => !used.has(view.id) && view.tabId === tab.id);
      const id = existing?.id || `notes-view-${++this.sequence}`;
      used.add(id); assignments.set(this.key(paneId, tab.id), id);
    }
    this.owners = assignments;
  }
  list(layout: NotesPaneLayout, tabs: NotesPaneTabs) {
    const views = notesPaneIds(layout).flatMap(paneId => (tabs[paneId] || []).map(tab => ({ paneId, tab, id: this.get(paneId, tab.id) })));
    const alive = new Set(views.map(view => this.key(view.paneId, view.tab.id)));
    for (const key of this.owners.keys()) if (!alive.has(key)) this.owners.delete(key);
    return views;
  }
  renameDocument(from: string, to: string) {
    const next = new Map<string,string>();
    for (const [key,id] of this.owners) {
      const [paneId,tabId] = JSON.parse(key) as [string,string];
      next.set(this.key(paneId,tabId === from ? to : tabId),id);
    }
    this.owners = next;
  }
  ids() { return new Set(this.owners.values()); }
  checkpoint() { const saved = new Map(this.owners); return () => { this.owners = new Map(saved); }; }
  clear() { this.owners.clear(); }
}
