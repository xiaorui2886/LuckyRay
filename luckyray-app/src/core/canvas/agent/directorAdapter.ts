import { cameraPreset, cloneScene, createDirectorObject, lightingPreset, sanitizeDirectorDocument, DIRECTOR_LIMITS } from '../director/model';
import { createRigPose, getObjectRigPose, mirrorRigPose, rigJointWorldTransforms, RIG_JOINTS, RIG_LIMITS, RIG_LIMBS, RIG_PRESETS, setJointRotation, solveLimbIK } from '../director/rig';
import type { DirectorRigPreset } from '../director/rig';
import type { DirectorCamera, DirectorDocument, DirectorJointId, DirectorLighting, DirectorLimb, DirectorObject, DirectorObjectKind, Vec3 } from '../director/types';
import type { CreationItem } from './creationTypes';

type ObjectPatch = Partial<Pick<DirectorObject, 'name'|'position'|'rotation'|'scale'|'color'|'visible'|'locked'>>;
export type DirectorOperation =
 | {action:'object.add';kind:DirectorObjectKind;name?:string;position?:Vec3}
 | {action:'object.update';objectId:string;patch:ObjectPatch}
 | {action:'pose.preset';objectId:string;preset:DirectorRigPreset}
 | {action:'pose.joint';objectId:string;joint:DirectorJointId;rotation:Vec3}
 | {action:'pose.ik';objectId:string;limb:DirectorLimb;target:Vec3;pole?:Vec3;space:'actor-local'}
 | {action:'pose.mirror';objectId:string}
 | {action:'camera.update';patch:Partial<DirectorCamera>}
 | {action:'camera.preset';preset:'wide'|'medium'|'close'|'overhead'}
 | {action:'camera.lookAt';target:Vec3}
 | {action:'lighting.update';patch:Partial<DirectorLighting>}
 | {action:'lighting.preset';preset:DirectorLighting['preset']}
 | {action:'presentation.update';mode:'original'|'clay';clayColor:string}
 | {action:'shot.add';name:string;duration?:number;notes?:string}
 | {action:'shot.update';shotId:string;name?:string;duration?:number;notes?:string;replaceScene?:boolean}
 | {action:'shot.restore';shotId:string}
 | {action:'shot.remove';shotId:string};

type Schema = {type?:string;const?:unknown;enum?:readonly unknown[];minimum?:number;maximum?:number;minLength?:number;maxLength?:number;pattern?:string;minItems?:number;maxItems?:number;minProperties?:number;properties?:Record<string,Schema>;required?:string[];additionalProperties?:boolean;items?:Schema;oneOf?:Schema[]};
const num=(minimum:number,maximum:number):Schema=>({type:'number',minimum,maximum});
const vec=(minimum:number,maximum:number):Schema=>({type:'array',items:num(minimum,maximum),minItems:3,maxItems:3});
const string=(maxLength:number,minLength=0):Schema=>({type:'string',maxLength,minLength});
const ident:Schema={...string(120,1),pattern:'^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$'};
const color:Schema={type:'string',pattern:'^#[a-fA-F0-9]{6}$'};
const bool:Schema={type:'boolean'};
const choice=(values:readonly string[]):Schema=>({type:'string',enum:values});
const obj=(properties:Record<string,Schema>,required=Object.keys(properties),minProperties?:number):Schema=>({type:'object',properties,required,additionalProperties:false,...(minProperties===undefined?{}:{minProperties})});
const objectPatch=obj({name:string(120,1),position:vec(-1000,1000),rotation:vec(-3600,3600),scale:vec(.05,100),color,visible:bool,locked:bool},[],1);
const cameraPatch=obj({position:vec(-1000,1000),target:vec(-1000,1000),up:vec(-1000,1000),focalLength:num(12,200),aspect:choice(['16:9','9:16','4:3','1:1','2.39:1'])},[],1);
const lightPatch=obj({preset:choice(['studio','day','night']),intensity:num(0,10),azimuth:num(-360,360),elevation:num(1,89),color,ambient:num(0,3),background:color,ground:color},[],1);
const op=(action:string,properties:Record<string,Schema>,required=Object.keys(properties))=>obj({action:{const:action},...properties},['action',...required]);
/** Shared strict schema: host can mirror this literal and parity-test every variant. */
export const DIRECTOR_OPERATION_SCHEMA:Schema={oneOf:[
 op('object.add',{kind:choice(['actor','box','sphere','cylinder','wall','platform']),name:string(120,1),position:vec(-1000,1000)},['kind']),
 op('object.update',{objectId:ident,patch:objectPatch}),
 op('pose.preset',{objectId:ident,preset:choice(RIG_PRESETS.map(p=>p.id))}),
 op('pose.joint',{objectId:ident,joint:choice(RIG_JOINTS.map(j=>j.id)),rotation:vec(-3600,3600)}),
 op('pose.ik',{objectId:ident,limb:choice(Object.keys(RIG_LIMBS)),target:vec(-1000,1000),pole:vec(-1000,1000),space:{const:'actor-local'}},['objectId','limb','target','space']),
 op('pose.mirror',{objectId:ident}),
 op('camera.update',{patch:cameraPatch}),op('camera.preset',{preset:choice(['wide','medium','close','overhead'])}),op('camera.lookAt',{target:vec(-1000,1000)}),
 op('lighting.update',{patch:lightPatch}),op('lighting.preset',{preset:choice(['studio','day','night'])}),
 op('presentation.update',{mode:choice(['original','clay']),clayColor:color}),
 op('shot.add',{name:string(120,1),duration:num(.1,3600),notes:string(8000)},['name']),
 op('shot.update',{shotId:ident,name:string(120,1),duration:num(.1,3600),notes:string(8000),replaceScene:bool},['shotId']),
 op('shot.restore',{shotId:ident}),op('shot.remove',{shotId:ident}),
]};
function fail(code='invalid'):never {throw Error(`canvas-agent-creation-director-${code}`);}
function matches(value:unknown,s:Schema):boolean {
 if(s.oneOf)return s.oneOf.filter(part=>matches(value,part)).length===1;
 if('const' in s&&value!==s.const)return false;
 if(s.enum&&!s.enum.includes(value))return false;
 if(s.type==='number')return typeof value==='number'&&Number.isFinite(value)&&value>=(s.minimum??-Infinity)&&value<=(s.maximum??Infinity);
 if(s.type==='string')return typeof value==='string'&&value.length>=(s.minLength??0)&&value.length<=(s.maxLength??Infinity)&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)&&(!s.pattern||new RegExp(s.pattern).test(value));
 if(s.type==='boolean')return typeof value==='boolean';
 if(s.type==='array')return Array.isArray(value)&&value.length>=(s.minItems??0)&&value.length<=(s.maxItems??Infinity)&&value.every(v=>matches(v,s.items!));
 if(s.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>,keys=Object.keys(v);
  return keys.length>=(s.minProperties??0)&&(s.required??[]).every(k=>Object.prototype.hasOwnProperty.call(v,k))&&keys.every(k=>Object.prototype.hasOwnProperty.call(s.properties!,k)&&matches(v[k],s.properties![k]));
 }
 return true;
}
export function validateDirectorOperation(value:unknown):DirectorOperation {
 if(!matches(value,DIRECTOR_OPERATION_SCHEMA))fail();
 const operation=value as DirectorOperation;
 if(operation.action==='shot.update'&&Object.keys(operation).length===2)fail('empty-edit');
 return operation;
}
/** Three.js Euler XYZ convention: apply scale, then Z/Y/X rotations, then translation. */
function actorPointToWorld(point:Vec3,object:DirectorObject):Vec3 {
 let [x,y,z]=point.map((v,i)=>v*object.scale[i]);
 const [rx,ry,rz]=object.rotation.map(v=>v*Math.PI/180);
 [x,y]=[x*Math.cos(rz)-y*Math.sin(rz),x*Math.sin(rz)+y*Math.cos(rz)];
 [x,z]=[x*Math.cos(ry)+z*Math.sin(ry),-x*Math.sin(ry)+z*Math.cos(ry)];
 [y,z]=[y*Math.cos(rx)-z*Math.sin(rx),y*Math.sin(rx)+z*Math.cos(rx)];
 return [x+object.position[0],y+object.position[1],z+object.position[2]];
}
export type DirectorEditResult={document:DirectorDocument;affectedIds:string[];details:Record<string,unknown>};
/** Pure isolated edit. Nothing reaches live canvas state until the caller commits the full batch. */
export function applyDirectorOperation(document:DirectorDocument,value:DirectorOperation,createId:()=>string):DirectorEditResult {
 const change=validateDirectorOperation(value),next=sanitizeDirectorDocument(document);
 if(!next)fail('invalid-document');
 const affectedIds:string[]=[],details:Record<string,unknown>={};
 const uniqueId=()=>{const id=createId();if(!matches(id,ident)||next.scene.objects.some(o=>o.id===id)||next.shots.some(s=>s.id===id)||(next.poseLibrary??[]).some(p=>p.id===id))fail('id-collision');return id;};
 const object=(id:string,actor=false)=>{const o=next.scene.objects.find(item=>item.id===id);if(!o)fail('missing-object');if(o.locked)fail('object-locked');if(actor&&o.kind!=='actor')fail('not-actor');affectedIds.push(id);return o;};
 const shot=(id:string)=>{const s=next.shots.find(item=>item.id===id);if(!s)fail('missing-shot');affectedIds.push(id);return s;};
 switch(change.action){
  case 'object.add':{if(next.scene.objects.length>=DIRECTOR_LIMITS.objects)fail('object-limit');const o=createDirectorObject(change.kind,uniqueId());if(change.name!==undefined)o.name=change.name;if(change.position)o.position=[...change.position];next.scene.objects.push(o);affectedIds.push(o.id);break;}
  case 'object.update':{const o=next.scene.objects.find(item=>item.id===change.objectId);if(!o)fail('missing-object');if(o.locked&&!(Object.keys(change.patch).length===1&&change.patch.locked===false))fail('object-locked');Object.assign(o,change.patch);affectedIds.push(o.id);break;}
  case 'pose.preset':{const o=object(change.objectId,true);o.rig=createRigPose(change.preset);break;}
  case 'pose.joint':{const o=object(change.objectId,true);o.rig=setJointRotation(getObjectRigPose(o),change.joint,change.rotation);details.requestedRotation=change.rotation;details.achievedRotation=o.rig.joints[change.joint];details.constrained=JSON.stringify(change.rotation)!==JSON.stringify(details.achievedRotation);break;}
  case 'pose.mirror':{const o=object(change.objectId,true);o.rig=mirrorRigPose(getObjectRigPose(o));break;}
  case 'pose.ik':{const o=object(change.objectId,true);o.rig=solveLimbIK(getObjectRigPose(o),change.limb,change.target,change.pole);const achieved=rigJointWorldTransforms(o.rig)[RIG_LIMBS[change.limb].end].position;const residual=Math.hypot(...achieved.map((v,i)=>v-change.target[i]));const requestedWorldTarget=actorPointToWorld(change.target,o),achievedWorldTarget=actorPointToWorld(achieved,o);Object.assign(details,{space:'actor-local',units:'metres',requestedTarget:[...change.target],achievedTarget:achieved,residualMetres:residual,reached:residual<.001,requestedWorldTarget,achievedWorldTarget,worldResidualMetres:Math.hypot(...achievedWorldTarget.map((v,i)=>v-requestedWorldTarget[i]))});break;}
  case 'camera.update':next.scene.camera={...next.scene.camera,...change.patch};break;
  case 'camera.preset':next.scene.camera={...cameraPreset(change.preset),...(next.scene.camera.up?{up:[...next.scene.camera.up] as Vec3}:{})};break;
  case 'camera.lookAt':next.scene.camera={...next.scene.camera,target:[...change.target]};break;
  case 'lighting.update':next.scene.lighting={...next.scene.lighting,...change.patch};break;
  case 'lighting.preset':next.scene.lighting=lightingPreset(change.preset);break;
  case 'presentation.update':next.scene.presentation={mode:change.mode,clayColor:change.clayColor};break;
  case 'shot.add':{if(next.shots.length>=DIRECTOR_LIMITS.shots)fail('shot-limit');const id=uniqueId();next.shots.push({id,name:change.name,duration:change.duration??5,notes:change.notes??'',scene:cloneScene(next.scene)});next.activeShotId=id;affectedIds.push(id);break;}
  case 'shot.update':{const s=shot(change.shotId);if(change.name!==undefined)s.name=change.name;if(change.duration!==undefined)s.duration=change.duration;if(change.notes!==undefined)s.notes=change.notes;if(change.replaceScene)s.scene=cloneScene(next.scene);break;}
  case 'shot.restore':next.scene=cloneScene(shot(change.shotId).scene);next.activeShotId=change.shotId;break;
  case 'shot.remove':shot(change.shotId);next.shots=next.shots.filter(s=>s.id!==change.shotId);if(next.activeShotId===change.shotId)delete next.activeShotId;break;
 }
 const clean=sanitizeDirectorDocument(next);if(!clean)fail('invalid-scene');
 return {document:clean,affectedIds,details};
}
export type DirectorReadQuery={scope:'scene'|'objects'|'shots'|'rig';objectId?:string;offset?:number};
export type DirectorReadPage={items:CreationItem[];offset:number;total:number;nextOffset?:number};
const field=(name:string,value:unknown)=>({name,value:typeof value==='string'?value:JSON.stringify(value)});
const item=(id:string,kind:string,title:string,values:Record<string,unknown>):CreationItem=>({id,kind,title,description:'',fields:Object.entries(values).filter(([,v])=>v!==undefined).map(([k,v])=>field(k,v))});
/** One bounded object or joint per item. Never truncate JSON or return a whole scene as text. */
export type DirectorReadEvidence = { spatialEvidence?: (object:DirectorObject) => Record<string,unknown> };
export function readDirectorDocument(document:DirectorDocument,query:DirectorReadQuery,evidence:DirectorReadEvidence={}):DirectorReadPage {
 const clean=sanitizeDirectorDocument(document);if(!clean)fail('invalid-document');
 if(!['scene','objects','shots','rig'].includes(query.scope)||!Number.isSafeInteger(query.offset??0)||(query.offset??0)<0)fail();
 let items:CreationItem[]=[];
 if(query.scope==='scene')items=[item('scene','directorScene','3D Director',{objectCount:clean.scene.objects.length,shotCount:clean.shots.length,camera:clean.scene.camera,lighting:clean.scene.lighting,presentation:clean.scene.presentation??{mode:'original',clayColor:'#d9d9d4'},activeShotId:clean.activeShotId,units:'metres; Euler XYZ degrees; IK targets actor-local',coordinateConvention:'Right-handed world coordinates; +Y is up; the ground plane is Y=0. Object position is the procedural asset root, not its geometric centre. Unrotated box/sphere/cylinder/wall/platform roots are at their base, so position.y=0 places their base on the ground; do not add half the height. Actor grounding depends on its rig pose/rootOffset. Scale is dimensionless and applied before Euler XYZ rotation and translation. Read directorObjects spatialEvidence after edits; use world bottomY, not position.y, for rotated/scaled/posed objects.',baseDimensionsMetres:{box:[1,1,1],sphere:[1,1,1],cylinder:[.9,1,.9],wall:[3,2.6,.16],platform:[2.4,.25,1.8],actor:'pose-dependent; inspect spatialEvidence'},rigPresets:RIG_PRESETS.map(p=>p.id),limits:DIRECTOR_LIMITS,workflow:'For a posed shot: read scene and object IDs; apply a pose preset, bounded joint or actor-local IK; inspect achieved pose/residual; set a camera preset or camera.update/lookAt; read back at the fresh canvas revision. shot.add/shot.update save Director scene snapshots only: they do not create storyboard cards or canvas images. To send a saved shot to the storyboard/canvas, explicitly use director.capture with its real boardId and shotId (omit name, or match the saved name). This captures the saved shot scene, stores a PNG and attaches an image storyboard child; it is not an image-generation model request. Then read the storyboard/image result and inspect the returned image and provenance. Camera metadata does not prove framing quality; opening a panel is not a capture.',capture:'Requires the actual renderer; metadata is not visual verification. If capture was not requested or did not complete, report the Director snapshot as saved but not published to storyboard/canvas.'})];
 if(query.scope==='objects') {
  const objects=clean.scene.objects.filter(o=>!query.objectId||o.id===query.objectId),offset=query.offset??0,total=objects.length,end=Math.min(total,offset+8);
  items=objects.slice(offset,end).map(o=>item(o.id,'directorObject',o.name,{kind:o.kind,position:o.position,rotation:o.rotation,scale:o.scale,color:o.color,visible:o.visible,locked:o.locked,spatialEvidence:evidence.spatialEvidence?.(o)??{status:'not-computed',verification:'Coordinates alone do not prove ground contact. Request directorObjects through the canvas runtime for mesh evidence.'},...(o.kind==='actor'?{pose:o.pose,rig:getObjectRigPose(o),jointLimits:RIG_LIMITS}:{} )}));
  return {items,offset,total,...(end<total?{nextOffset:end}:{})};
 }
 if(query.scope==='shots')for(const shot of clean.shots.filter(s=>!query.objectId||s.id===query.objectId)){
  const chunks:{start:number;end:number;text:string}[]=[];
  for(let start=0;start<shot.notes.length;){let end=Math.min(start+4000,shot.notes.length);if(end<shot.notes.length&&shot.notes.charCodeAt(end-1)>=0xd800&&shot.notes.charCodeAt(end-1)<=0xdbff&&shot.notes.charCodeAt(end)>=0xdc00&&shot.notes.charCodeAt(end)<=0xdfff)end--;chunks.push({start,end,text:shot.notes.slice(start,end)});start=end;}
  const chunked=chunks.length>1;
  items.push(item(shot.id,'directorShot',shot.name,{duration:shot.duration,...(!chunked?{notes:shot.notes}:{}),notesChunkCount:chunked?chunks.length:0,notesLength:shot.notes.length,notesEncoding:'UTF-16 offsets; concatenate directorShotNotesChunk text fields in chunkIndex order',objectCount:shot.scene.objects.length,camera:shot.scene.camera,lighting:shot.scene.lighting,active:clean.activeShotId===shot.id}));
  if(chunked)chunks.forEach((chunk,index)=>items.push(item(`${shot.id}:notes:${index}`,'directorShotNotesChunk',shot.name,{shotId:shot.id,chunkIndex:index,chunkCount:chunks.length,start:chunk.start,end:chunk.end,text:chunk.text})));
 }
 if(query.scope==='rig')for(const o of clean.scene.objects.filter(o=>o.kind==='actor'&&(!query.objectId||o.id===query.objectId))){const rig=getObjectRigPose(o),world=rigJointWorldTransforms(rig);for(const j of RIG_JOINTS)items.push(item(`${o.id}:${j.id}`,'directorJoint',j.labelEn,{objectId:o.id,joint:j.id,parent:j.parent,rotation:rig.joints[j.id]??[0,0,0],limits:RIG_LIMITS[j.id],actorLocalPosition:world[j.id].position}));}
 const offset=query.offset??0,total=items.length,end=Math.min(total,offset+8);
 return {items:items.slice(offset,end),offset,total,...(end<total?{nextOffset:end}:{})};
}
