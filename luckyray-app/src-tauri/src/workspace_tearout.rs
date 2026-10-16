//! Tab-only native gesture proof. A proof does not move/close a view: the host
//! must still complete freeze/flush + rendered revision ACK + final revision.
//! Production stays disabled until packaged Windows physical-gesture acceptance.
use serde::Serialize;
use std::{collections::HashMap,time::{Duration,Instant}};

pub(crate) const PRODUCTION_PHYSICAL_TEAROUT_VERIFIED: bool = false;
const TTL:Duration=Duration::from_secs(20);
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub(crate) struct PhysicalPoint {pub x:i32,pub y:i32}
#[derive(Clone,Debug)]
pub(crate) struct NativeWindowBounds {pub label:String,pub native_id:isize,pub x:i32,pub y:i32,pub width:u32,pub height:u32,pub scale:f64}
impl NativeWindowBounds {
 fn contains(&self,p:PhysicalPoint)->bool{let x=i64::from(p.x);let y=i64::from(p.y);x>=i64::from(self.x)&&y>=i64::from(self.y)&&x<i64::from(self.x)+i64::from(self.width)&&y<i64::from(self.y)+i64::from(self.height)}
 fn valid(&self)->bool{self.native_id!=0&&self.width>0&&self.height>0&&self.scale.is_finite()&&self.scale>0.0&&self.scale<=16.0}
}
/// Native-only input, intentionally not Deserialize. Renderer coordinates and
/// reported mouse states can never be substituted for this observation.
#[derive(Clone,Copy,Debug)]
pub(crate) struct NativeObservation {pub point:PhysicalPoint,pub primary_down:bool,pub escape_down:bool,pub foreground:isize,pub under_cursor:isize}
#[derive(Clone)]
struct Pending {source:NativeWindowBounds,view_id:String,grant:String,start:PhysicalPoint,created:Instant}
#[derive(Default)]
pub(crate) struct WorkspaceTearout {pending:HashMap<String,Pending>}
#[derive(Clone,Debug,Serialize,PartialEq,Eq)]
#[serde(tag="kind",rename_all="camelCase")]
pub(crate) enum NativeDropIntent {NewWindow{#[serde(rename="physicalX")] physical_x:i32,#[serde(rename="physicalY")] physical_y:i32},ExistingWindow{label:String}}
impl WorkspaceTearout {
 fn prune(&mut self){self.pending.retain(|_,p|p.created.elapsed()<TTL);}
 pub(crate) fn begin(&mut self,source:NativeWindowBounds,view_id:String,grant:String,native:NativeObservation)->Result<String,String>{
  self.prune();
  if !source.valid()||view_id.is_empty()||view_id.len()>512||grant.is_empty()||grant.len()>1024{return Err("workspace-gesture-invalid-scope".into());}
  if !native.primary_down||native.escape_down||native.foreground!=source.native_id||!source.contains(native.point){return Err("workspace-gesture-not-active".into());}
  self.pending.retain(|_,p|p.source.label!=source.label);
  if self.pending.len()>=24{return Err("workspace-gesture-capacity".into());}
  let id=format!("{:032x}",rand::random::<u128>());
  self.pending.insert(id.clone(),Pending{source,view_id,grant,start:native.point,created:Instant::now()});Ok(id)
 }
 pub(crate) fn view(&mut self,caller:&str,id:&str)->Result<String,String>{self.prune();let p=self.pending.get(id).ok_or("workspace-gesture-expired")?;if p.source.label!=caller{return Err("workspace-gesture-scope".into());}Ok(p.view_id.clone())}
 pub(crate) fn cancel(&mut self,caller:&str,id:&str){if self.pending.get(id).is_some_and(|p|p.source.label==caller){self.pending.remove(id);}}
 pub(crate) fn remove_window(&mut self,caller:&str){self.pending.retain(|_,p|p.source.label!=caller);}
 pub(crate) fn finish(&mut self,caller:&str,id:&str,current_grant:&str,source:&NativeWindowBounds,windows:&[NativeWindowBounds],native:NativeObservation)->Result<NativeDropIntent,String>{
  self.prune();let pending=self.pending.get(id).ok_or("workspace-gesture-expired")?;
  if pending.source.label!=caller{return Err("workspace-gesture-scope".into());}
  let pending=self.pending.remove(id).ok_or("workspace-gesture-expired")?;
  if current_grant!=pending.grant||source.label!=caller||!source.valid()||source.native_id!=pending.source.native_id{return Err("workspace-gesture-grant-changed".into());}
  if source.x!=pending.source.x||source.y!=pending.source.y||source.width!=pending.source.width||source.height!=pending.source.height||source.scale!=pending.source.scale{return Err("workspace-gesture-window-changed".into());}
  // A zero GetAsyncKeyState result can mean unavailable input, so also require
  // our original OS window still be the foreground owner. Blur cancels safely.
  if native.primary_down||native.escape_down||native.foreground!=source.native_id{return Err("workspace-gesture-release-unproven".into());}
  let dx=f64::from(native.point.x)-f64::from(pending.start.x);let dy=f64::from(native.point.y)-f64::from(pending.start.y);
  if dx.hypot(dy)<6.0*pending.source.scale||source.contains(native.point){return Err("workspace-gesture-not-outside".into());}
  let hits=windows.iter().filter(|w|w.contains(native.point)).collect::<Vec<_>>();
  if hits.is_empty(){return Ok(NativeDropIntent::NewWindow{physical_x:native.point.x,physical_y:native.point.y});}
  let actual=hits.into_iter().filter(|w|w.valid()&&w.native_id==native.under_cursor&&w.label!=caller).collect::<Vec<_>>();
  if actual.len()==1{return Ok(NativeDropIntent::ExistingWindow{label:actual[0].label.clone()});}
  Err("workspace-gesture-target-ambiguous".into())
 }
}

/// GetPhysicalCursorPos and WindowFromPhysicalPoint use physical desktop pixels,
/// matching Tauri outer_position()/outer_size(); no JS screenX/DPI conversion.
/// Microsoft docs: /windows/win32/api/winuser/nf-winuser-getphysicalcursorpos,
/// nf-winuser-getasynckeystate (high bit only, SM_SWAPBUTTON respected).
#[cfg(windows)]
pub(crate) fn observe_native()->Result<NativeObservation,String>{
 #[repr(C)]#[derive(Clone,Copy)]struct Point{x:i32,y:i32}
 #[link(name="user32")]extern "system"{
  fn GetPhysicalCursorPos(point:*mut Point)->i32;
  fn GetAsyncKeyState(key:i32)->i16;
  fn GetSystemMetrics(index:i32)->i32;
  fn GetForegroundWindow()->isize;
  fn WindowFromPhysicalPoint(point:Point)->isize;
  fn GetAncestor(window:isize,flags:u32)->isize;
 }
 let mut point=Point{x:0,y:0};
 // SAFETY: documented User32 signatures, stack-owned POINT, no stored pointer.
 unsafe{
  if GetPhysicalCursorPos(&mut point)==0{return Err("workspace-native-cursor-unavailable".into());}
  let foreground=GetForegroundWindow();if foreground==0{return Err("workspace-native-foreground-unavailable".into());}
  let primary=if GetSystemMetrics(23)!=0{2}else{1};
  Ok(NativeObservation{point:PhysicalPoint{x:point.x,y:point.y},primary_down:GetAsyncKeyState(primary)<0,escape_down:GetAsyncKeyState(0x1b)<0,foreground,under_cursor:GetAncestor(WindowFromPhysicalPoint(point),2)})
 }
}
#[cfg(not(windows))]
pub(crate) fn observe_native()->Result<NativeObservation,String>{Err("workspace-native-gesture-unsupported".into())}

#[cfg(test)]mod tests{
 use super::*;
 fn source()->NativeWindowBounds{NativeWindowBounds{label:"main".into(),native_id:1,x:-100,y:0,width:800,height:600,scale:1.5}}
 fn observation(x:i32,y:i32,down:bool)->NativeObservation{NativeObservation{point:PhysicalPoint{x,y},primary_down:down,escape_down:false,foreground:1,under_cursor:0}}
 #[test]fn valid_outside_release_is_one_use_and_physical(){let mut s=WorkspaceTearout::default();let w=source();let id=s.begin(w.clone(),"note".into(),"scope-A".into(),observation(0,10,true)).unwrap();assert!(s.finish("foreign",&id,"scope-A",&w,&[w.clone()],observation(900,20,false)).is_err());assert_eq!(s.finish("main",&id,"scope-A",&w,&[w.clone()],observation(900,20,false)).unwrap(),NativeDropIntent::NewWindow{physical_x:900,physical_y:20});assert!(s.finish("main",&id,"scope-A",&w,&[],observation(900,20,false)).is_err());}
 #[test]fn held_button_escape_blur_changed_grant_and_small_moves_never_detach(){for case in 0..5{let mut s=WorkspaceTearout::default();let w=source();let id=s.begin(w.clone(),"note".into(),"A".into(),observation(695,10,true)).unwrap();let mut end=observation(705,10,false);let mut grant="A";match case{0=>end.primary_down=true,1=>end.escape_down=true,2=>end.foreground=9,3=>grant="B",_=>end.point.x=701};assert!(s.finish("main",&id,grant,&w,&[],end).is_err());}}
 #[test]fn expiry_cancel_and_close_keep_source(){let mut s=WorkspaceTearout::default();let w=source();let id=s.begin(w.clone(),"n".into(),"A".into(),observation(0,0,true)).unwrap();s.cancel("foreign",&id);assert!(s.view("main",&id).is_ok());s.cancel("main",&id);assert!(s.view("main",&id).is_err());let id=s.begin(w,"n".into(),"A".into(),observation(0,0,true)).unwrap();s.pending.get_mut(&id).unwrap().created=Instant::now()-Duration::from_secs(21);assert!(s.view("main",&id).is_err());}
 #[test]fn existing_target_requires_actual_native_hover(){let mut s=WorkspaceTearout::default();let w=source();let mut target=w.clone();target.label="workspace-target".into();target.native_id=2;target.x=800;let id=s.begin(w.clone(),"n".into(),"A".into(),observation(0,0,true)).unwrap();assert!(s.finish("main",&id,"A",&w,&[target.clone()],observation(900,20,false)).is_err());let id=s.begin(w.clone(),"n".into(),"A".into(),observation(0,0,true)).unwrap();let mut end=observation(900,20,false);end.under_cursor=2;assert_eq!(s.finish("main",&id,"A",&w,&[target],end).unwrap(),NativeDropIntent::ExistingWindow{label:"workspace-target".into()});}
 #[test]fn production_gate_stays_closed_without_windows_acceptance(){assert!(!PRODUCTION_PHYSICAL_TEAROUT_VERIFIED);}
}
