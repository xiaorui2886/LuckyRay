"""Attachment boundaries, mixed text resize, selection paint and refresh continuity."""
from playwright.sync_api import sync_playwright
from urllib.request import urlopen
import json
import os
from pathlib import Path

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    failures = []
    try:
        page = browser.new_page(viewport={'width': 1200, 'height': 900})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:18763', wait_until='networkidle')
        page.evaluate("document.querySelector('#root').style.width='1000px'")
        def reset(text, pos=0):
            page.evaluate('(text)=>window.reset(text)', text)
            page.wait_for_timeout(120)
            page.evaluate('(pos)=>window.handle.setSelection({start:pos,end:pos})', pos)
            page.wait_for_timeout(80)
        def check(ok, label, evidence):
            if not ok: failures.append((label, evidence))
        for text in ['text\n![[a.svg|300]]后面的文字', 'text![[a.svg|300]]后面的文字']:
            end = text.index('后')
            for y in [0.2, 0.7]:
                reset(text)
                r = page.locator('.note-media').bounding_box()
                page.mouse.click(r['x']+r['width']+2, r['y']+r['height']*y)
                selection = page.evaluate('window.handle.getSelection()')
                check(selection == {'start':end,'end':end}, 'right edge caret', [text,y,selection])
                page.keyboard.insert_text('X')
                check(page.evaluate('window.value') == text[:end]+'X'+text[end:], 'right edge typing', page.evaluate('window.value'))
        text='text\n![[a.svg|300]]后面的文字'
        end=text.index('后')
        for pos in [5,end]:
            reset(text,pos)
            r=page.locator('.note-media').bounding_box()
            c=page.locator('.cm-cursor').first.bounding_box()
            check(c and abs(c['height']-r['height'])<4,'boundary caret height',[pos,c,r,page.evaluate('({assoc:window.view().state.selection.main.assoc,minus:window.view().coordsAtPos(window.view().state.selection.main.head,-1),plus:window.view().coordsAtPos(window.view().state.selection.main.head,1)})')])
        reset(text)
        page.locator('.note-media').click(position={'x':80,'y':80})
        check(page.evaluate('window.handle.getSelection()')=={'start':5,'end':end},'exact attachment selection',page.evaluate('window.handle.getSelection()'))
        backgrounds=page.locator('.cm-selectionBackground').evaluate_all('(els)=>els.map(e=>({color:getComputedStyle(e).backgroundColor,display:getComputedStyle(e).display}))')
        check(all(b['color']=='rgba(0, 0, 0, 0)' or b['display']=='none' for b in backgrounds),'attachment-only paint',backgrounds)
        if os.environ.get('KNOWLEDGE_UX_EVIDENCE_DIR'):
            folder=Path(os.environ['KNOWLEDGE_UX_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True)
            page.screenshot(path=str(folder/'mixed-edge-selection.png'))
        # Real mouse resize; the maximum is the content box, not 720 or the
        # space left over after the adjacent text's intrinsic width.
        reset('text\n![[a.svg|300]]一二三四五六七八九十甲乙丙丁戊己庚辛壬癸')
        handle=page.locator('.lr-live-asset-resize').bounding_box()
        r=page.locator('.note-media').bounding_box()
        limit=page.locator('.note-media').evaluate('(el)=>{const p=el.parentElement,s=getComputedStyle(p);return p.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)}')
        page.mouse.move(handle['x']+handle['width']/2,handle['y']+handle['height']/2)
        page.mouse.down()
        reflow=[]
        for target_width in [700,800,900,limit]:
            page.mouse.move(handle['x']+handle['width']/2+target_width-300,handle['y'],steps=4)
            page.wait_for_timeout(40)
            reflow.append(page.evaluate('''() => {
              const card=document.querySelector('.note-media'),box=card.getBoundingClientRect();
              const walker=document.createTreeWalker(card.parentElement,NodeFilter.SHOW_TEXT);let beside=0;
              while(walker.nextNode()){const n=walker.currentNode;if(!n.textContent.includes('一二三'))continue;
                for(let i=0;i<n.length;i++){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+1);if(r.getBoundingClientRect().top<box.bottom)beside++}}
              return {width:box.width,beside};
            }'''))
        page.mouse.move(r['x']+limit+80,handle['y'],steps=12)
        page.mouse.up()
        page.wait_for_timeout(150)
        width=page.locator('.note-media').bounding_box()['width']
        check(abs(width-limit)<3,'full content resize',[width,limit,page.evaluate('window.value')])
        check(reflow[0]['beside']>reflow[1]['beside']>reflow[2]['beside']>=reflow[3]['beside'] and reflow[-1]['beside']==0,'progressive character wrap',reflow)
        check(page.evaluate("window.value.endsWith('一二三四五六七八九十甲乙丙丁戊己庚辛壬癸')"),'resize preserves trailing text',page.evaluate('window.value'))
        page.keyboard.press('Control+z')
        page.wait_for_timeout(100)
        check(abs(page.locator('.note-media').bounding_box()['width']-300)<2,'resize undo',page.evaluate('window.value'))
        page.keyboard.press('Control+y')
        page.wait_for_timeout(100)
        check(abs(page.locator('.note-media').bounding_box()['width']-limit)<2,'resize redo',page.evaluate('window.value'))
        reset('![[a.svg|300]]\nend')
        page.evaluate("window.oldCard=document.querySelector('.note-media');window.oldImage=window.oldCard.querySelector('img');window.invalidateSource()")
        observations=[]
        for _ in range(14):
            page.wait_for_timeout(50)
            observations.append(page.evaluate("({same:window.oldCard===document.querySelector('.note-media'),pixels:!!document.querySelector('.note-media img')?.naturalWidth,state:document.querySelector('.lr-live-asset-preview').dataset.imageState})"))
        check(all(o['same'] and o['pixels'] and o['state'] not in ['loading','error'] for o in observations),'refresh keeps card/pixels',observations)
        check(page.locator('.note-media img').evaluate('(e)=>e.src.endsWith("v=1")'),'refresh eventually uses new version',None)
        # A slower obsolete decode cannot overwrite the latest revision; a
        # failure is explicit, keeps its known preview, and can recover.
        page.evaluate('window.invalidateSource()')
        page.wait_for_timeout(100)
        page.evaluate('window.invalidateSource()')
        page.wait_for_timeout(750)
        check(page.locator('.note-media img').evaluate('(e)=>e.src.endsWith("v=3")'),'latest revision wins',None)
        page.evaluate('window.revision=97;window.invalidateSource()')
        page.wait_for_timeout(700)
        check(page.locator('.lr-live-asset-preview').get_attribute('data-image-state')=='preview-error','refresh failure is visible',None)
        check(page.locator('.note-media img').evaluate('(e)=>e.src.endsWith("v=3")&&e.naturalWidth>0'),'failure retains known preview',None)
        page.evaluate('window.invalidateSource()')
        page.wait_for_timeout(700)
        check(page.locator('.note-media img').evaluate('(e)=>e.src.endsWith("v=99")'),'recovery loads new version',None)
        # Publishing a genuinely new attachment doesn't remount existing ones.
        page.evaluate('window.oldCard=document.querySelector(".note-media");window.oldImage=window.oldCard.querySelector("img");const p=window.value.length;window.handle.setSelection({start:p,end:p})')
        page.evaluate('window.publish()')
        check(page.evaluate('window.oldCard===document.querySelector(".note-media")&&window.oldImage===window.oldCard.querySelector("img")'),'publication retains existing DOM',None)
        check(not errors,'browser exceptions',errors)
        print('reflow',json.dumps(reflow))
        print(json.dumps(failures,ensure_ascii=False,indent=2))
        assert not failures, failures
        print('PASS attachment mixed editing')
    finally:
        browser.close()
        urlopen('http://127.0.0.1:18763/__close').close()
