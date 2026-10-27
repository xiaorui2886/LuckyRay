"""Consecutive media insertion: actual CodeMirror layout, not typing afterwards."""
from playwright.sync_api import sync_playwright
from urllib.request import urlopen
import json
import os
from pathlib import Path

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    try:
        page = browser.new_page(viewport={'width': 1000, 'height': 800})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto('http://127.0.0.1:18763', wait_until='networkidle')
        page.wait_for_selector('.lr-live-asset-card img')
        page.evaluate("window.reset('')")
        page.wait_for_timeout(100)
        page.evaluate("window.handle.setSelection({start:0,end:0});window.insert()")
        page.wait_for_selector('.lr-live-asset-card img')
        page.wait_for_timeout(100)
        measure = """() => {
          const v=window.view(), s=v.state.selection.main;
          const boxes=Array.from(document.querySelectorAll('.lr-live-asset-card')).map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}});
          return {text:window.value,caret:s.head,line:v.state.doc.lineAt(s.head).number,coords:v.coordsAtPos(s.head),boxes,
            lines:Array.from(document.querySelectorAll('.cm-line')).map(e=>({text:e.textContent,height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top}))};
        }"""
        first=page.evaluate(measure)
        print('first:', json.dumps(first))
        assert first['text']=='![[a.svg]]\n' and first['line']==2
        assert 0 < first['coords']['top']-first['boxes'][0]['bottom'] < 20, 'caret belongs immediately below media'
        assert first['coords']['bottom']-first['coords']['top']<30
        page.evaluate('window.insert()')
        page.wait_for_timeout(150)
        second=page.evaluate(measure)
        print('second:', json.dumps(second))
        assert second['text']=='![[a.svg]]\n![[a.svg]]\n'
        assert 0 <= second['boxes'][1]['top']-second['boxes'][0]['bottom']<=16, 'no three-line media gap'
        for text, caret in [('text![[a.svg]]',4), ('text\n![[a.svg]]',4), ('![[a.svg]]text',14)]:
            page.evaluate('(text)=>window.reset(text)',text)
            page.wait_for_timeout(100)
            page.evaluate('(pos)=>window.handle.setSelection({start:pos,end:pos})',caret)
            page.wait_for_timeout(100)
            print('adjacent:', json.dumps(page.evaluate(measure)))
            native=page.evaluate("(()=>{const s=window.getSelection(),r=s.getRangeAt(0).getBoundingClientRect();return {node:s.anchorNode?.textContent,offset:s.anchorOffset,height:r.height,top:r.top,right:r.right}})()")
            assert native['node']=='text' and native['offset']==4, native
            assert 0 < native['height'] < 30, 'native caret must match the text, not the picture height'
            # Actual pointer placement then input at the visible end of prose.
            page.mouse.click(native['right'],native['top']+native['height']/2)
            assert page.evaluate('window.handle.getSelection().start')==min(caret,len(text))
            page.keyboard.insert_text('X')
            assert page.evaluate('window.value')==text[:caret]+'X'+text[caret:]
        # Cold first attachment: delayed image decode in a long, scrolled note.
        page.evaluate("window.reset(('paragraph\\n\\n').repeat(100))")
        page.wait_for_timeout(100)
        page.evaluate("window.handle.setSelection({start:600,end:600})")
        page.wait_for_timeout(100)
        old_top=page.evaluate('window.view().scrollDOM.scrollTop')
        assert old_top>0
        page.evaluate('window.insertCold()')
        samples=[]
        for _ in range(12):
            page.wait_for_timeout(100)
            samples.append(page.evaluate('window.view().scrollDOM.scrollTop'))
        assert max(abs(top-old_top) for top in samples)<3, (old_top,samples)
        assert page.locator('.lr-live-asset-card img').count()==1
        assert not errors, errors
        if os.environ.get('KNOWLEDGE_UX_EVIDENCE_DIR'):
            folder=Path(os.environ['KNOWLEDGE_UX_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True)
            page.evaluate("window.reset('text![[a.svg]]')")
            page.wait_for_timeout(100)
            page.evaluate('window.handle.setSelection({start:4,end:4})')
            page.screenshot(path=str(folder/'adjacent-text-caret.png'))
        print('PASS: consecutive images, immediate caret, adjacent prose/native caret/click/input, cold decode viewport; errors=',errors)
    finally:
        browser.close()
        urlopen('http://127.0.0.1:18763/__close').close()
