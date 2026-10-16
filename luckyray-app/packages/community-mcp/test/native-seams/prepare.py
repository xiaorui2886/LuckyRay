#!/usr/bin/env python3
"""Prepare isolated native contract harnesses. Host dependencies are STUBS.
Never report this as a full desktop build or real KnowledgeService acceptance.
"""
import argparse,pathlib
p=argparse.ArgumentParser();p.add_argument('--out',type=pathlib.Path,required=True);out=p.parse_args().out.resolve()
here=pathlib.Path(__file__).resolve().parent;app=here.parents[3];src=app/'src-tauri/src'
for family in ['native','grant']:
 root=out/family;(root/'src').mkdir(parents=True,exist_ok=True)
 (root/'Cargo.toml').write_bytes((here/(family+'-Cargo.toml')).read_bytes())
 code=(here/(family+'-lib.rs')).read_text().replace('__GRANT_SOURCE__',(src/'local_transport/materials_grants.rs').as_posix())
 (root/'src/lib.rs').write_text(code)
root=out/'native'
for name in ['community_mcp.rs','community_mcp_package.rs','community_mcp_knowledge.rs','community_mcp_process.rs']:
 code=(src/name).read_text().replace('#[tauri::command]\n','')
 if name=='community_mcp.rs':
  code='use crate::tauri;\n'+code.replace('//!','//').replace('../../packages/community-mcp/src/secret-store.ps1',(app/'packages/community-mcp/src/secret-store.ps1').as_posix())
 (root/'src'/name).write_text(code)
(root/'community-mcp').mkdir(exist_ok=True)
(root/'community-mcp/catalog.json').write_bytes((app/'src-tauri/community-mcp/catalog.json').read_bytes())
print('Prepared actual feature modules with explicitly stubbed host seams:',out)
