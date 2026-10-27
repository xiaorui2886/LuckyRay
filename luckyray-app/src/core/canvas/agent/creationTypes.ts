import type { DirectorOperation } from './directorAdapter';
/** R11 canvas-scoped creative operations. No filesystem paths, provider keys or raw media URLs. */
export type CreationScope='overview'|'referencePacks'|'templates'|'storyboards'|'shots'|'review'|'directions'|'delivery'|'scriptText'|'directorScene'|'directorObjects'|'directorShots';
export type CreationReadQuery={scope:CreationScope;objectId?:string;offset?:number;expectedRevision?:string};
export type CreationField={name:string;value:string};
export type CreationItem={id:string;kind:string;title:string;description:string;memberIds?:string[];fields?:CreationField[]};
/** Revision includes creative metadata and history, not viewport/selection. Pages fail closed on revision mismatch. */
export type CreationReadResult={version:1;revision:string;scope:CreationScope;offset:number;total:number;nextOffset?:number;items:CreationItem[];completion:'read'|'applied'|'awaiting-user'|'applied-unconfirmed';notice?:string};
export type CreationShotFields={title?:string;description?:string;action?:string;dialogue?:string;lighting?:string;sound?:string;cameraMovement?:string;durationSeconds?:number;framing?:'wide'|'full'|'medium'|'close'|'detail'};
export type CreationOperation=
 | {op:'director.capture';boardId:string;shotId?:string;name?:string}
 | {op:'director.create';name:string}
 | {op:'director.edit';boardId:string;change:DirectorOperation}
 | {op:'referencePack.create';name:string;packKind:'character'|'product'|'style';nodeIds:string[]}
 | {op:'referencePack.update';packId:string;name?:string;packKind?:'character'|'product'|'style';nodeIds?:string[]}
 | {op:'referencePack.unmark';packId:string}
 | {op:'referencePack.apply';packId:string;targetId:string}
 | {op:'template.instantiate';templateId:string}
 | {op:'storyboard.create';name:string;nodeIds?:string[]}
 | {op:'storyboard.rename';boardId:string;name:string}
 | {op:'storyboard.unmark';boardId:string}
 | {op:'storyboard.importScript';boardId:string;sourceText:string}
 | {op:'shot.add';boardId:string;kind:'image'|'video';fields:CreationShotFields}
 | {op:'shot.update';boardId:string;shotId:string;fields:CreationShotFields;prompt?:string}
 | {op:'shot.duplicate';boardId:string;shotId:string}
 | {op:'shot.detach';boardId:string;shotId:string}
 | {op:'shot.reorder';boardId:string;shotIds:string[]}
 | {op:'shot.adopt';boardId:string;shotId:string;candidateIndex:number}
 | {op:'shot.clearChoice';boardId:string;shotId:string}
 | {op:'generator.recipe';nodeId:string;recipe:null|{version:1;id:string;options:Record<string,string|number>}}
 | {op:'generator.cinematography';nodeId:string;settings:Record<string,string|number|boolean>}
 | {op:'reference.role';sourceId:string;targetId:string;role:'generic'|'reference'|'promptContext'|'firstFrame'|'lastFrame'|'videoReference'}
 | {op:'reference.order';targetId:string;sourceIds:string[]}
 | {op:'review.prefer';historyId:string;mediaIndex:number;preferred:boolean}
 | {op:'review.restore';historyId:string;mediaIndex:number}
 | {op:'review.continue';historyId:string;mediaIndex:number};
export type CreationEditRequest={expectedRevision:string} & ({operation:CreationOperation;operations?:never}|{operations:CreationOperation[];operation?:never});
/** These are explicit handoffs only, never completion of an export/image edit/import. */
export type CreationOpenRequest={expectedRevision:string;panel:'imageTools'|'delivery'|'templateImport'|'templateExport'|'storyboardExport';nodeIds?:string[];objectId?:string;imageIndex?:number;imageEdit?:{turns:number;flipX:boolean;flipY:boolean;crop:{x:number;y:number;width:number;height:number};width:number;height:number}};

