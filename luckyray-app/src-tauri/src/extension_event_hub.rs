//! In-memory, scoped, at-most-once delivery. No history is scanned or replayed.
use crate::extension_broker::Scope;
use crate::extension_packages_store::{Installed, State};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone)]
struct Subscription { generation:String, id:String, digest:String, epoch:u64, contribution:String, kind:String, scope:Scope }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Claim { pub id:String, pub scope:Scope, pub event:Value }
#[derive(Clone)]
struct Pending { id:String, digest:String, epoch:u64, claim:Claim }
pub enum SourceEvent<'a> {
    Knowledge { vault_id:&'a str, relative_path:&'a str },
    Materials { library_id:&'a str, ids:&'a [String] },
}
#[derive(Default)]
pub struct EventHub { subscriptions:Vec<Subscription>, pending:BTreeMap<String,Pending>, recent:VecDeque<String>, pub dropped:u64 }

fn is_current(state:&State,id:&str,digest:&str,epoch:u64)->bool {
    state.packages.iter().any(|p| p.enabled && p.package.manifest.id == id && p.digest == digest && p.epoch == epoch && p.grants.iter().any(|g|g == "events.subscribe"))
}
impl EventHub {
    pub fn subscribe(&mut self, package:&Installed, scope:&Scope, contribution:&str, kind:&str)->Result<(),String> {
        if scope.event_delivery { return Err("plugin-event-recursion-denied".into()); }
        if !package.enabled || !package.grants.iter().any(|p|p == "events.subscribe") || !scope.events_allowed.iter().any(|p|p == kind) {
            return Err("plugin-event-not-selected".into());
        }
        match kind {
            "knowledge.saved" if package.grants.iter().any(|p|p == "knowledge.read")
                && scope.knowledge.as_ref().is_some_and(|s|!s.documents.is_empty()) => {},
            "materials.imported" if package.grants.iter().any(|p|p == "materials.read")
                && scope.event_material_library_id.is_some() => {},
            "knowledge.saved" | "materials.imported" => return Err("plugin-event-object-required".into()),
            _ => return Err("plugin-parameters".into()),
        }
        if scope.event_allow_ai && (scope.ai_selection.is_none() || !package.grants.iter().any(|p|p == "ai.generate")) {
            return Err("plugin-event-ai-not-selected".into());
        }
        let id = package.package.manifest.id.clone();
        let replacing = self.subscriptions.iter().any(|s| s.id == id && s.contribution == contribution && s.kind == kind);
        if !replacing && (self.subscriptions.len() >= 64 || self.subscriptions.iter().filter(|s|s.id == id).count() >= 8) {
            return Err("plugin-event-limit".into());
        }
        self.subscriptions.retain(|s| !(s.id == id && s.contribution == contribution && s.kind == kind));
        self.pending.retain(|_,p| !(p.id == id && p.claim.event["contribution"] == contribution && p.claim.event["notification"]["type"] == kind));
        let mut granted_scope = scope.clone();
        if !scope.event_allow_ai { granted_scope.ai_selection = None; }
        self.subscriptions.push(Subscription { generation:rand::random::<[u8;16]>().iter().map(|b|format!("{b:02x}")).collect(), id, digest:package.digest.clone(), epoch:package.epoch, contribution:contribution.into(), kind:kind.into(), scope:granted_scope });
        Ok(())
    }
    pub fn unsubscribe(&mut self, id:&str, kind:&str)->Result<(),String> {
        if !["knowledge.saved", "materials.imported"].contains(&kind) { return Err("plugin-parameters".into()); }
        self.subscriptions.retain(|s| !(s.id == id && s.kind == kind));
        self.pending.retain(|_,p| !(p.id == id && p.claim.event["notification"]["type"] == kind));
        Ok(())
    }
    pub fn retain_current(&mut self, state:&State) {
        self.subscriptions.retain(|s|is_current(state,&s.id,&s.digest,s.epoch));
        self.pending.retain(|_,p|is_current(state,&p.id,&p.digest,p.epoch));
    }
    pub fn kinds(&self,id:&str)->Vec<String> {
        let mut kinds:Vec<_>=self.subscriptions.iter().filter(|s|s.id == id).map(|s|s.kind.clone()).collect();
        kinds.sort(); kinds.dedup(); kinds
    }
    pub fn active(&self,id:&str,digest:&str,epoch:u64,contribution:&str,kind:&str)->bool {
        self.subscriptions.iter().any(|s|s.id==id && s.digest==digest && s.epoch==epoch && s.contribution==contribution && s.kind==kind)
    }
    pub fn active_generation(&self,id:&str,digest:&str,epoch:u64,contribution:&str,kind:&str,generation:Option<&str>)->bool {
        self.active(id,digest,epoch,contribution,kind) && self.subscriptions.iter().any(|s|s.id==id && s.contribution==contribution && s.kind==kind && Some(s.generation.as_str())==generation)
    }
    pub fn publish(&mut self, event_id:&str, source:SourceEvent<'_>)->Vec<String> {
        if self.recent.iter().any(|id|id == event_id) { return vec![]; }
        self.recent.push_back(event_id.to_string());
        if self.recent.len() > 1024 { self.recent.pop_front(); }
        let mut tokens = Vec::new();
        for sub in &self.subscriptions {
            let mut scope = sub.scope.clone();
            scope.writes = false; scope.export_path = None; scope.events_allowed.clear(); scope.event_delivery = true; scope.event_allow_ai = false;
            scope.event_subscription_generation = Some(sub.generation.clone());
            scope.event_digest = Some(sub.digest.clone()); scope.event_epoch = Some(sub.epoch);
            scope.material_ids.clear(); scope.canvas_ids.clear();
            let truncated;
            match &source {
                SourceEvent::Knowledge {vault_id,relative_path} if sub.kind == "knowledge.saved" => {
                    let Some(k) = scope.knowledge.as_mut() else { continue };
                    if k.vault_id != *vault_id || !k.documents.iter().any(|p|p == relative_path) { continue; }
                    k.documents = vec![relative_path.to_string()]; k.allow_create = false; k.parent_relative_path = None;
                    scope.material_library_id = None; scope.event_material_library_id = None; truncated = false;
                }
                SourceEvent::Materials {library_id,ids} if sub.kind == "materials.imported" => {
                    if scope.event_material_library_id.as_deref() != Some(*library_id) || ids.is_empty() { continue; }
                    scope.knowledge = None;
                    scope.material_library_id = scope.event_material_library_id.take();
                    scope.material_ids = ids.iter().take(32).cloned().collect(); truncated = ids.len() > 32;
                }
                _ => continue,
            }
            if self.pending.len() >= 128 { self.dropped = self.dropped.saturating_add(1); continue; }
            let token = rand::random::<[u8;16]>().iter().map(|b|format!("{b:02x}")).collect::<String>();
            let claim = Claim { id:sub.id.clone(), scope, event:json!({"contribution":sub.contribution,"action":"event","fields":{},"notification":{"type":sub.kind,"id":event_id,"truncated":truncated}}) };
            self.pending.insert(token.clone(),Pending { id:sub.id.clone(),digest:sub.digest.clone(),epoch:sub.epoch,claim });
            tokens.push(token);
        }
        tokens
    }
    pub fn claim(&mut self, token:&str, state:&State)->Result<Claim,String> {
        let item = self.pending.remove(token).ok_or("plugin-event-unavailable")?;
        if !is_current(state,&item.id,&item.digest,item.epoch) { return Err("plugin-retired".into()); }
        Ok(item.claim)
    }
    pub fn discard(&mut self, token:&str) { self.pending.remove(token); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extension_broker::KnowledgeScope;
    fn package()->Installed {
        serde_json::from_value(json!({"enabled":true,"digest":"fixture-digest","epoch":1,"grants":["events.subscribe","knowledge.read","materials.read"],"package":{"manifest":{"schemaVersion":1,"apiVersion":1,"id":"test.events","name":"Events","version":"1.0.0","type":"script","entry":"main.js","minHostVersion":"1.9.2","requiredModules":["events","knowledge","materials"],"optionalModules":[]},"resource":{"code":"LuckyRay.register(()=>null)","requiredPermissions":["events.subscribe"],"optionalPermissions":["knowledge.read","materials.read"],"dataVersion":1,"contributions":[{"id":"run","label":"Run","kind":"panel"}]}}})).unwrap()
    }
    fn scope()->Scope {
        Scope { writes:true, export_path:Some("private-output".into()), material_ids:vec!["unrelated".into()], event_material_library_id:Some("library-a".into()), canvas_ids:vec!["unrelated-canvas".into()], knowledge:Some(KnowledgeScope {allow_create:true,vault_id:"vault-a".into(),source_epoch:1,documents:vec!["allowed.md".into()],parent_relative_path:Some("private-parent".into())}), events_allowed:vec!["knowledge.saved".into(),"materials.imported".into()], ..Scope::default() }
    }
    fn state(package:Installed)->State { State {revision:1,packages:vec![package],host_version:"1.9.2".into()} }
    #[test]
    fn only_selected_note_or_library_is_delivered_and_claims_are_single_use() {
        let package = package(); let state = state(package.clone()); let mut hub = EventHub::default();
        hub.subscribe(&package,&scope(),"run","knowledge.saved").unwrap();
        hub.subscribe(&package,&scope(),"run","materials.imported").unwrap();
        assert!(hub.publish("e1",SourceEvent::Knowledge {vault_id:"vault-b",relative_path:"allowed.md"}).is_empty());
        assert!(hub.publish("e2",SourceEvent::Knowledge {vault_id:"vault-a",relative_path:"other.md"}).is_empty());
        assert!(hub.publish("e3",SourceEvent::Materials {library_id:"library-b",ids:&["private".into()]}).is_empty());
        let tokens=hub.publish("e4",SourceEvent::Knowledge {vault_id:"vault-a",relative_path:"allowed.md"});
        assert_eq!(tokens.len(),1);
        assert!(hub.publish("e4",SourceEvent::Knowledge {vault_id:"vault-a",relative_path:"allowed.md"}).is_empty());
        let claim=hub.claim(&tokens[0],&state).unwrap();
        assert_eq!(claim.event["notification"]["type"],"knowledge.saved");
        assert!(hub.active("test.events","fixture-digest",1,"run","knowledge.saved"));
        assert_eq!(claim.scope.knowledge.unwrap().documents,vec!["allowed.md"]);
        assert!(claim.scope.material_ids.is_empty() && claim.scope.canvas_ids.is_empty() && claim.scope.material_library_id.is_none());
        assert!(!claim.scope.writes && claim.scope.event_delivery && claim.scope.export_path.is_none());
        assert_eq!(hub.claim(&tokens[0],&state).unwrap_err(),"plugin-event-unavailable");
        hub.unsubscribe("test.events","knowledge.saved").unwrap();
        assert!(!hub.active("test.events","fixture-digest",1,"run","knowledge.saved"));
        let ids:Vec<String>=(0..35).map(|n|format!("asset-{n}")).collect();
        let token=hub.publish("e5",SourceEvent::Materials {library_id:"library-a",ids:&ids}).remove(0);
        let claim=hub.claim(&token,&state).unwrap();
        assert_eq!(claim.scope.material_ids.len(),32);
        assert!(claim.scope.knowledge.is_none());
        assert_eq!(claim.event["notification"]["truncated"],true);
    }
    #[test]
    fn unsubscribe_disable_and_missing_authority_remove_delivery() {
        let mut package=package(); let mut hub=EventHub::default();
        let mut denied=scope(); denied.events_allowed.clear();
        assert_eq!(hub.subscribe(&package,&denied,"run","knowledge.saved"),Err("plugin-event-not-selected".into()));
        let mut recursive=scope(); recursive.event_delivery=true;
        assert_eq!(hub.subscribe(&package,&recursive,"run","knowledge.saved"),Err("plugin-event-recursion-denied".into()));
        package.grants.retain(|g|g != "knowledge.read");
        assert_eq!(hub.subscribe(&package,&scope(),"run","knowledge.saved"),Err("plugin-event-object-required".into()));
        package.grants.push("knowledge.read".into());
        hub.subscribe(&package,&scope(),"run","knowledge.saved").unwrap();
        let token=hub.publish("e6",SourceEvent::Knowledge {vault_id:"vault-a",relative_path:"allowed.md"}).remove(0);
        hub.unsubscribe("test.events","knowledge.saved").unwrap();
        assert_eq!(hub.claim(&token,&state(package.clone())).unwrap_err(),"plugin-event-unavailable");
        hub.subscribe(&package,&scope(),"run","knowledge.saved").unwrap();
        let token=hub.publish("e7",SourceEvent::Knowledge {vault_id:"vault-a",relative_path:"allowed.md"}).remove(0);
        package.enabled=false; hub.retain_current(&state(package.clone()));
        assert_eq!(hub.claim(&token,&state(package)).unwrap_err(),"plugin-event-unavailable");
        assert!(hub.publish("e8",SourceEvent::Knowledge {vault_id:"vault-a",relative_path:"allowed.md"}).is_empty());
    }
    #[test]
    fn event_ai_requires_separate_opt_in_and_saved_ai_permission() {
        let mut package=package(); let mut scope=scope(); let mut hub=EventHub::default();
        scope.ai_selection=Some(crate::extension_broker::AiSelection {provider:"fixture".into(),model:"mock".into(),fingerprint:"a".repeat(64)});
        hub.subscribe(&package,&scope,"run","knowledge.saved").unwrap();
        let token=hub.publish("without-opt-in",SourceEvent::Knowledge {vault_id:"vault-a",relative_path:"allowed.md"}).remove(0);
        assert!(hub.claim(&token,&state(package.clone())).unwrap().scope.ai_selection.is_none());
        scope.event_allow_ai=true;
        assert_eq!(hub.subscribe(&package,&scope,"run","knowledge.saved"),Err("plugin-event-ai-not-selected".into()));
        package.grants.push("ai.generate".into());
        hub.subscribe(&package,&scope,"run","knowledge.saved").unwrap();
        let token=hub.publish("with-opt-in",SourceEvent::Knowledge {vault_id:"vault-a",relative_path:"allowed.md"}).remove(0);
        assert!(hub.claim(&token,&state(package)).unwrap().scope.ai_selection.is_some());
    }
    #[test]
    fn replacing_subscription_invalidates_queued_and_claimed_old_generation(){
        let package=package();let state=state(package.clone());let mut hub=EventHub::default();
        let a=scope();hub.subscribe(&package,&a,"run","knowledge.saved").unwrap();
        let first=hub.publish("before",SourceEvent::Knowledge{vault_id:"vault-a",relative_path:"allowed.md"}).remove(0);
        let claimed=hub.claim(&first,&state).unwrap();
        let pending=hub.publish("queued",SourceEvent::Knowledge{vault_id:"vault-a",relative_path:"allowed.md"}).remove(0);
        let mut b=scope();b.knowledge.as_mut().unwrap().documents=vec!["next.md".into()];hub.subscribe(&package,&b,"run","knowledge.saved").unwrap();
        assert!(hub.claim(&pending,&state).is_err());
        assert!(!hub.active_generation("test.events","fixture-digest",1,"run","knowledge.saved",claimed.scope.event_subscription_generation.as_deref()));
        let next=hub.publish("next",SourceEvent::Knowledge{vault_id:"vault-a",relative_path:"next.md"}).remove(0);assert!(hub.claim(&next,&state).is_ok());
    }

}
