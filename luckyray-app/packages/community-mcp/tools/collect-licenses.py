#!/usr/bin/env python3
"""Maintainer-only: collect full license texts from pinned Go module release ZIPs.
No runtime or user configuration is read. Run before build-package.py.
"""
import concurrent.futures,hashlib,io,json,pathlib,urllib.request,zipfile,time
import argparse
p=argparse.ArgumentParser();p.add_argument('--vendor',type=pathlib.Path,required=True);root=p.parse_args().vendor
archive=root/'tunnel-client-runtime-cloudflared-v0.0.16-windows-amd64.zip'
if hashlib.sha256(archive.read_bytes()).hexdigest()!='02346814ccd0a9a7a4e6d3d494e225c2befb095ede0c46cbe8d71a8d952acfcc':raise ValueError('upstream archive checksum mismatch')
with zipfile.ZipFile(archive) as z:report=z.read('tunnel-client-runtime-cloudflared-v0.0.16-windows-amd64-licenses.txt').decode()
paths=sorted(set(r.split('|')[4] for r in report.splitlines() if r.count('|')==5 and not r.startswith('DEPENDENCY')))
cache=root/'license-cache';cache.mkdir(exist_ok=True)
def get(path):
 try:
  if '@' not in path:raise ValueError('unresolved license path')
  module,rest=path.split('@',1);version,filename=rest.split('/',1)
  url='https://proxy.golang.org/'+module+'/@v/'+version+'.zip'
  local=cache/(hashlib.sha256(url.encode()).hexdigest()+'.zip')
  if local.exists():raw=local.read_bytes()
  else:
   with urllib.request.urlopen(url,timeout=40) as response:raw=response.read(48*1024*1024+1)
   if len(raw)>48*1024*1024:raise ValueError('archive budget exceeded')
   local.write_bytes(raw)
  with zipfile.ZipFile(io.BytesIO(raw)) as z:
   matches=[n for n in z.namelist() if n.endswith('@'+version+'/'+filename)]
   if len(matches)!=1:raise ValueError('license not found: '+filename)
   info=z.getinfo(matches[0])
   if info.file_size>1024*1024:raise ValueError('license budget exceeded')
   text=z.read(info).decode('utf-8')
  return {'path':path,'url':url,'text':text,'sha256':hashlib.sha256(text.encode()).hexdigest()}
 except Exception as e:return {'path':path,'error':str(e)}
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
 rows=[]
 for row in pool.map(get,paths):rows.append(row);print(('OK ' if 'text' in row else 'ERR ')+row['path'],flush=True)
(root/'licenses-evidence.json').write_text(json.dumps([{k:v for k,v in r.items() if k!='text'} for r in rows],indent=2))
(root/'THIRD_PARTY_LICENSES.txt').write_text('\n\n'.join('===== '+r['path']+' =====\nSource: '+r['url']+'\n\n'+r['text'] for r in rows if 'text'in r))
print('TOTAL',len(rows),'OK',sum('text'in r for r in rows),'ERROR',sum('error'in r for r in rows))

if any("error" in r for r in rows):raise SystemExit(1)
