import test from "node:test";
import assert from "node:assert/strict";
import { cachedFilmstrip, retainFilmstrip, filmSampleTimes, filmThumbnailCount, filmTime, filmPreciseTime, parseFilmPosition, displayedFilmFrame } from "../src/features/materials/materialFilmTools.ts";

test("filmstrip cache is revision scoped and bounded by entry count and bytes", () => {
  const images=[{src:"data:test",time:1,start:0,end:2}];
  retainFilmstrip("library:A:asset:X:revision1",images);
  assert.equal(cachedFilmstrip("library:A:asset:X:revision1"),images);
  assert.equal(cachedFilmstrip("library:A:asset:X:revision2"),undefined);
  assert.equal(cachedFilmstrip("library:B:asset:X:revision1"),undefined);
  for(let i=0;i<9;i++)retainFilmstrip(`bounded:${i}`,images);
  assert.equal(cachedFilmstrip("bounded:0"),undefined);
  assert.equal(cachedFilmstrip("bounded:8"),images);
  retainFilmstrip("oversized",[{...images[0],src:"x".repeat(5*1024*1024)}]);
  assert.equal(cachedFilmstrip("oversized"),undefined);
});

test("timeline sampling is finite and bounded independently of long duration", () => {
  for (const duration of [0.01,8,120,86400]) {
    const times=filmSampleTimes(duration,5000);
    assert.equal(times.length,48);
    assert.ok(times.every((time,i)=>time>0&&time<duration&&(!i||time>times[i-1])));
  }
  for (const duration of [0,-1,Infinity,NaN]) assert.deepEqual(filmSampleTimes(duration),[]);
});
test("filmstrip density follows viewport and portrait aspect, with finite work", () => {
  assert.equal(filmThumbnailCount(1048,16/9),13);
  assert.equal(filmThumbnailCount(368,240/426),14);
  assert.ok(filmThumbnailCount(1800,9/16)>filmThumbnailCount(1800,16/9));
  for(const width of [0,400,100000,Infinity,NaN])for(const aspect of [0,.1,1,10,NaN]) {
    const count=filmThumbnailCount(width,aspect);assert.ok(count>=8&&count<=48);
  }
  assert.equal(filmSampleTimes(8,NaN).length,12);
});
test("media clock supports hours without claiming frame precision", () => {
  assert.equal(filmTime(3661.99),"1:01:01");
  assert.equal(filmTime(3.25),"00:03");
  assert.equal(filmTime(NaN),"00:00");
});
test("precise seconds position accepts long media and rejects malformed or out-of-bounds input", () => {
  assert.equal(filmPreciseTime(3661.125), "1:01:01.125");
  assert.equal(filmPreciseTime(59.9999), "01:00.000");
  assert.equal(parseFilmPosition("1:01:01.125", 4000), 3661.125);
  assert.equal(parseFilmPosition("75.35", 120), 75.35);
  assert.equal(parseFilmPosition("01:15.350", 120), 75.35);
  for (const bad of ["", "-1", "1:60", "0:00:99", "1:02:03:04", "1.1234", "NaN", "Infinity", "121"]) assert.equal(parseFilmPosition(bad, 120), null);
  assert.equal(parseFilmPosition("120", 120), 120);
  assert.equal(parseFilmPosition("0", 0), null);
});
test("capture rejects undecoded/seeking/oversized frames before canvas allocation", () => {
  for(const input of [
    {readyState:1,seeking:false,videoWidth:640,videoHeight:360},
    {readyState:4,seeking:true,videoWidth:640,videoHeight:360},
    {readyState:4,seeking:false,videoWidth:0,videoHeight:0},
    {readyState:4,seeking:false,videoWidth:20000,videoHeight:20000},
  ]) assert.throws(()=>displayedFilmFrame(input as HTMLVideoElement));
});
