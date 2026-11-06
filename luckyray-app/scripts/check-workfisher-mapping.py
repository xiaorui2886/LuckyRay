#!/usr/bin/env python3
"""Compare bundled, sanitized branch mappings with the exact provided UI export.

Usage: python3 scripts/check-workfisher-mapping.py /path/to/original.json
This is offline and never contacts ComfyUI or starts a generation.
"""
import hashlib
import json
import sys
from pathlib import Path

EXPECTED = 'b9e7f7cc0a0666df6d48701262acc516b0e3b2b4c4b51f505d3576a0feb7c658'
if len(sys.argv) != 2:
    raise SystemExit('Provide the original Work-Fisher UI JSON file.')
raw = Path(sys.argv[1]).read_bytes()
if hashlib.sha256(raw).hexdigest() != EXPECTED:
    raise SystemExit('Original file SHA-256 does not match the reviewed attachment.')
workflow = json.loads(raw)
nodes = {node['id']: node for node in workflow['nodes']}
links = {link[0]: link for link in workflow['links']}
assert len(nodes) == 101 and len(links) == 105


def resolve(node_id, port):
    node = nodes[node_id]
    # The cleanup nodes act on system memory/processes or VRAM. Do not place
    # them in a generated preset; connect the image stream around them.
    if node['type'] in ('Reroute', 'RAMCleanup', 'VRAMCleanup'):
        incoming = [item for item in node['inputs'] if item.get('link') is not None]
        assert len(incoming) == 1
        link = links[incoming[0]['link']]
        return resolve(link[1], link[2])
    return node_id, port


def branch(output):
    result, seen = {}, set()

    def visit(node_id):
        if node_id in seen:
            return
        seen.add(node_id)
        node = nodes[node_id]
        assert node['type'] not in ('Reroute', 'RAMCleanup', 'VRAMCleanup')
        names = [item['name'] for item in node.get('inputs', []) if item.get('widget')]
        values = node.get('widgets_values') or []
        if isinstance(values, list):
            if node['type'] == 'ResolutionSelector':
                names = [name for name in names if name != 'preview']
            if node['type'] in ('RandomNoise', 'KSampler'):
                values = values[:1] + values[2:]  # UI-only randomization control
            assert len(names) == len(values), (node_id, names)
            inputs = dict(zip(names, values))
        else:
            inputs = {key: value for key, value in values.items() if key in names}
        for item in node.get('inputs', []):
            if item.get('link') is None:
                continue
            if node['type'] == 'MiniMaxH3ReferenceToVideo' and item['name'].startswith('ref_images.') and item['name'] != 'ref_images.ref_image_0':
                continue  # Rebuilt at request time from the ordered canvas inputs.
            link = links[item['link']]
            parent, port = resolve(link[1], link[2])
            inputs[item['name']] = [str(parent), port]
            visit(parent)
        if node['type'] == 'LoadImage':
            inputs = {'image': 'luckyray-reference-0.png'}
        if node_id in (138, 214, 248, 277):
            inputs[{138: 'value', 214: 'prompt', 248: 'text', 277: 'text'}[node_id]] = ''
        if node['type'] == 'RandomNoise':
            inputs['noise_seed'] = 0
        if node['type'] == 'KSampler':
            inputs['seed'] = 0
        if node['type'] in ('VHS_VideoCombine', 'SaveImage'):
            inputs['filename_prefix'] = 'LuckyRay/short-drama'
        result[str(node_id)] = {'class_type': node['type'], 'inputs': inputs}

    visit(output)
    return result


derived = {'video': branch(156), 'threeView': branch(212), 'character': branch(241), 'scene': branch(267)}
bundled = json.loads((Path(__file__).parent.parent / 'src/core/canvas/workFisherData.json').read_text(encoding='utf-8'))
if derived != bundled:
    raise SystemExit('Bundled mapping differs from the reviewed UI export.')
print('PASS: original SHA-256 and four sanitized output-branch mappings match.')
