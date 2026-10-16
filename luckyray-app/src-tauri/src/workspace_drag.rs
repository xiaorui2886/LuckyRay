//! Short-lived, single-claim drag tickets. Payloads contain no paths or content.
use std::{collections::HashMap,time::{Duration,Instant}};
use super::workspace_windows::ViewGrant;

#[derive(Clone)]
pub(crate) struct DragTicket {pub source:String,pub view:ViewGrant,pub target:Option<String>,created:Instant}
#[derive(Default)]
pub(crate) struct WorkspaceDrags {tickets:HashMap<String,DragTicket>}
impl WorkspaceDrags {
    fn prune(&mut self){self.tickets.retain(|_,ticket|ticket.created.elapsed()<Duration::from_secs(45));}
    pub fn begin(&mut self,id:String,source:String,view:ViewGrant)->Result<(),String>{
        self.prune();
        if id.len()!=36||!id.bytes().all(|b|b.is_ascii_hexdigit()||b==b'-'){return Err("workspace-invalid-drag".into());}
        if self.tickets.len()>=24||self.tickets.contains_key(&id){return Err("workspace-drag-limit".into());}
        self.tickets.insert(id,DragTicket{source,view,target:None,created:Instant::now()});Ok(())
    }
    pub fn claim(&mut self,id:&str,target:&str)->Result<DragTicket,String>{
        self.prune();let ticket=self.tickets.get_mut(id).ok_or("workspace-drag-expired")?;
        if ticket.source==target||ticket.target.is_some(){return Err("workspace-drag-already-claimed".into());}
        ticket.target=Some(target.into());Ok(ticket.clone())
    }
    pub fn cancel(&mut self,id:&str,source:&str){if self.tickets.get(id).is_some_and(|ticket|ticket.source==source&&ticket.target.is_none()){self.tickets.remove(id);}}
    pub fn remove_window(&mut self,label:&str){self.tickets.retain(|_,ticket|ticket.source!=label&&ticket.target.as_deref()!=Some(label));}
}

#[cfg(test)] mod tests {
 use super::*;
 #[test] fn tickets_are_single_claim_scoped_and_expiring(){
  let mut drags=WorkspaceDrags::default();let id="12345678-1234-1234-1234-123456789012";
  let view=ViewGrant{id:"note".into(),kind:"note".into(),library_id:"A".into(),resource_id:Some("a.md".into()),title:"A".into()};
  drags.begin(id.into(),"source".into(),view.clone()).unwrap();drags.cancel(id,"foreign");
  assert!(drags.claim(id,"source").is_err());assert_eq!(drags.claim(id,"target").unwrap().view,view);
  drags.cancel(id,"source");assert!(drags.claim(id,"other").is_err());drags.remove_window("target");
  drags.begin(id.into(),"source".into(),view).unwrap();drags.tickets.get_mut(id).unwrap().created=Instant::now()-Duration::from_secs(46);
  assert!(drags.claim(id,"target").is_err());
 }
}
