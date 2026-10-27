// Static synthetic layout evidence; same topology, viewport and fit rule.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT).href);
const out='output/playwright/graph-r6';
const datasets=['sparse','dense','large'].flatMap(name=>['R5','R6-production'].map(variant=>JSON.parse(readFileSync(`${out}/${name}-${variant}.json`,'utf8'))));
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1500},deviceScaleFactor:1});
  await page.setContent('<body style="margin:0;background:#111"><canvas width="1440" height="1500"></canvas></body>');
  await page.evaluate(datasets=>{
    const ctx=document.querySelector('canvas').getContext('2d');
    datasets.forEach(({result,nodes,edges},i)=>{
      const ox=i%2*720,oy=Math.floor(i/2)*500,b=result.whole,s=Math.min(640/b.w,400/b.h);
      const p=n=>[ox+360+(n.x-b.x-b.w/2)*s,oy+270+(n.y-b.y-b.h/2)*s];
      const map=new Map(nodes.map(n=>[n.id,n]));
      ctx.fillStyle='#ddd';ctx.font='18px sans-serif';ctx.fillText(`${result.fixture} / ${result.variant} — synthetic`,ox+24,oy+30);
      ctx.strokeStyle='#7777';ctx.lineWidth=.65;
      for(const [a,b] of edges){ctx.beginPath();ctx.moveTo(...p(map.get(a)));ctx.lineTo(...p(map.get(b)));ctx.stroke();}
      ctx.fillStyle='#ccc';for(const n of nodes){ctx.beginPath();ctx.arc(...p(n),1.6,0,Math.PI*2);ctx.fill();}
    });
  },datasets);
  await page.screenshot({path:out+'/comparison.png'});
} finally {await browser.close();}
