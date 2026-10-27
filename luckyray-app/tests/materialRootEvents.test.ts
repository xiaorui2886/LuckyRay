import assert from "node:assert/strict";
import test from "node:test";
import { MaterialRootEvents, RootEventBatch, type RootEvent } from "../src/features/materials/materialRootEvents.ts";

test("event batches dedupe paths, reconcile overflow and retain events arriving during a drained batch", () => {
  const batch = new RootEventBatch();
  batch.add("A", ["one", "one", "two"]); batch.add("B", ["three"]);
  const first = batch.drain(); batch.add("A", ["later"]);
  assert.deepEqual([...first.get("A")!], ["one", "two"]);
  assert.deepEqual([...batch.drain().get("A")!], ["later"]);
  batch.add("A", ["one"]); batch.add("A", null); batch.add("A", ["two"]);
  assert.equal(batch.drain().get("A"), null);
  batch.add("A", Array.from({length:4097}, (_,i)=>String(i)));
  assert.equal(batch.drain().get("A"), null);
});

test("toggle off ignores late native events and disposes an asynchronously attached old watcher only", async () => {
  const callbacks: ((event:RootEvent)=>void)[]=[];
  const resolutions: ((stop:()=>Promise<void>)=>void)[]=[];
  const events: unknown[]=[];const stopped:number[]=[];const errors:unknown[]=[];
  const watches=new MaterialRootEvents(async(_id,_root,receive)=>{
    callbacks.push(receive); return new Promise(resolve=>resolutions.push(resolve));
  },(id,event)=>events.push({id,event}),(_id,error)=>errors.push(error));
  watches.sync([{id:"B",root:"old"}]); watches.sync([{id:"B",root:"old"}]);
  assert.equal(callbacks.length,1,"no duplicate subscription on preferences/registry refresh");
  watches.stop(); callbacks[0]({paths:["old-file"]});
  watches.sync([{id:"B",root:"new"}]);
  resolutions[0](async()=>{stopped.push(0);});resolutions[1](async()=>{stopped.push(1);});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(stopped,[0]);assert.equal(events.length,1,"only replacement's initial reconcile");
  callbacks[0]({paths:["late-old"]});callbacks[1]({paths:["new-file"]});
  assert.equal(events.length,2);watches.stop();await Promise.resolve();
  assert.deepEqual(stopped,[0,1]);assert.deepEqual(errors,[]);
});
