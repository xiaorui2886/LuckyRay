"""Real CM arrow stops, inline typing, selection/open and translucent viewer."""
from playwright.sync_api import sync_playwright
from urllib.request import urlopen
import json
import os
from pathlib import Path

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    try:
        page = browser.new_page(viewport={'width': 1000, 'height': 800})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:18763', wait_until='networkidle')
        def reset(text, pos):
            page.evaluate('(s)=>window.reset(s)', text)
            page.wait_for_timeout(80)
            page.evaluate('(p)=>window.handle.setSelection({start:p,end:p})', pos)
            page.wait_for_timeout(80)
        def selection():
            return page.evaluate('window.handle.getSelection()')
        text = 'text\n![[a.svg|300]]\nafter'
        end = text.index('\nafter')
        reset(text, 4)
        for key in ['ArrowRight', 'ArrowDown']:
            reset(text, 4)
            for expected in [(5,5),(5,end),(end,end)]:
                page.keyboard.press(key)
                assert selection() == dict(zip(('start','end'),expected)), (key,selection(),expected)
            cursor = page.locator('.cm-cursor').first.bounding_box()
            card_box = page.locator('.note-media').bounding_box()
            assert cursor and card_box and abs(cursor['height']-card_box['height'])<4, (cursor,card_box)
        page.keyboard.insert_text('hello')
        assert page.evaluate('window.value') == text[:end]+'hello'+text[end:]
        geometry = page.evaluate('''() => {
          const v=window.view(),r=document.querySelector('.note-media').getBoundingClientRect(),c=v.coordsAtPos(v.state.selection.main.head);
          return {r:r.toJSON(),c};
        }''')
        assert geometry['c']['left'] > geometry['r']['right'], geometry
        assert geometry['c']['top'] < geometry['r']['bottom']+20, geometry
        reset(text, end)
        for expected in [(5,end),(5,5),(4,4)]:
            page.keyboard.press('ArrowLeft')
            assert selection()==dict(zip(('start','end'),expected)),selection()
        reset('text![[a.svg]]',4)
        cursor=page.locator('.cm-cursor').first.bounding_box()
        prose=page.locator('.cm-line').first.bounding_box()
        assert cursor and prose and abs(cursor['y']-prose['y'])<10,(cursor,prose)
        reset('text\n![[a.svg]]\nafter',4)
        for _ in range(3): page.keyboard.press('ArrowRight')
        page.keyboard.insert_text('wrap')
        geom = page.evaluate('''() => { const v=window.view();return {r:document.querySelector('.note-media').getBoundingClientRect().toJSON(),c:v.coordsAtPos(v.state.selection.main.head)} }''')
        assert geom['c']['top'] >= geom['r']['bottom'], geom
        reset(text,0)
        card=page.locator('.note-media')
        card.click(position={'x':70,'y':70})
        assert selection()=={'start':5,'end':end}
        assert page.locator('.note-image-viewer').count()==0
        color=card.evaluate('(el)=>getComputedStyle(el,"::after").backgroundColor')
        assert color=='rgba(0, 0, 0, 0)',color
        if os.environ.get('KNOWLEDGE_UX_EVIDENCE_DIR'):
            folder=Path(os.environ['KNOWLEDGE_UX_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True)
            page.screenshot(path=str(folder/'edge-selection.png'))
        card.click(position={'x':70,'y':70})
        page.wait_for_selector('.note-image-viewer[open]')
        assert page.locator('.note-image-viewer-toolbar button').all_text_contents()==['','']
        bg=page.locator('.note-image-viewer').evaluate('(el)=>({bg:getComputedStyle(el).backgroundColor,back:getComputedStyle(el,"::backdrop").backgroundColor})')
        assert bg['bg']=='rgba(0, 0, 0, 0)' and bg['back'].startswith('rgba('),bg
        if os.environ.get('KNOWLEDGE_UX_EVIDENCE_DIR'):
            page.screenshot(path=str(folder/'translucent-image-viewer.png'))
        page.keyboard.press('Escape')
        assert page.locator('.note-image-viewer').count()==0
        assert not errors,errors
        print('PASS navigation, inline/wrapped typing, edge selection, second click, translucent icon viewer',json.dumps(geometry))
    finally:
        browser.close()
        urlopen('http://127.0.0.1:18763/__close').close()
