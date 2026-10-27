from playwright.sync_api import sync_playwright
from urllib.request import urlopen
from pathlib import Path
import os

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    try:
        page = browser.new_page(viewport={'width':1000, 'height':800})
        errors=[]
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:18763', wait_until='networkidle')
        page.wait_for_selector('.lr-live-asset-card img')
        page.evaluate("window.reset('before')")
        page.evaluate("window.handle.setSelection({start:6,end:6});window.insert()")
        page.wait_for_selector('.lr-live-asset-card img')
        page.keyboard.insert_text('typing after image')
        page.wait_for_timeout(150)
        result=page.evaluate("({text:window.value,block:!!document.querySelector('.lr-live-asset-card.block'),selection:window.handle.getSelection(),scroll:window.view().scrollDOM.scrollTop})")
        print('after insertion/typing:', result)
        assert result['text'].endswith('![[a.svg]]\ntyping after image'), 'insertion must leave the immediate text landing line after media'
        assert page.locator('.lr-live-asset-card.note-media').count()==1, 'typing after insertion retains the rendered media'
        page.evaluate("window.reset('before\\n\\n![[a.svg]]\\n\\nafter')")
        page.wait_for_timeout(150)
        card=page.locator('.lr-live-asset-card').bounding_box()
        after=page.locator('.cm-line').filter(has_text='after').bounding_box()
        before=page.locator('.cm-line').filter(has_text='before').bounding_box()
        page.mouse.move(after['x']+50, after['y']+10)
        page.mouse.down()
        page.mouse.move(card['x']+80, card['y']+card['height']/2, steps=12)
        page.mouse.up()
        selected=page.evaluate("({selection:window.handle.getSelection(),selected:!!document.querySelector('.lr-live-asset-card.selected'),source:!!document.querySelector('.lr-live-asset-source')})")
        print('drag into image:', selected)
        assert selected['selected'] and not selected['source'], 'drag from text into image selects the media as a whole, without exposing source'
        page.mouse.move(after['x']+40,after['y']+10);page.mouse.down()
        page.mouse.move(before['x'],before['y']+10,steps=20);page.mouse.up()
        assert page.locator('.lr-live-asset-card.selected').count()==1, 'drag across media selects it too'
        # Starting inside the non-editable media must also extend into text.
        page.evaluate("window.handle.setSelection({start:0,end:0})")
        page.evaluate("new Promise(requestAnimationFrame)")
        card=page.locator('.lr-live-asset-card').bounding_box()
        after=page.locator('.cm-line').filter(has_text='after').bounding_box()
        assert 0 < after['y']-(card['y']+card['height']) < 65, 'media/text gap must stay bounded, not a half-image line'
        page.mouse.move(card['x']+100,card['y']+80);page.mouse.down()
        page.mouse.move(after['x']+40,after['y']+10,steps=15);page.mouse.up()
        state=page.evaluate("({from:window.view().state.selection.main.from,to:window.view().state.selection.main.to,selected:!!document.querySelector('.lr-live-asset-card.selected'),tint:getComputedStyle(document.querySelector('.lr-live-asset-card'),'::after').backgroundColor})")
        assert state['from']==8 and state['to']>18 and state['selected'], state
        assert state['tint']=='rgba(0, 0, 0, 0)', 'media selection uses its edge, without tinting the image'
        if os.environ.get('KNOWLEDGE_UX_EVIDENCE_DIR'):
            evidence=Path(os.environ['KNOWLEDGE_UX_EVIDENCE_DIR'])
            evidence.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(evidence/'media-range-selection.png'))
        # Insert into already-separated text: reuse the existing blank lines,
        # but leave the caret outside the attachment before typing.
        page.evaluate("window.reset('before\\n\\nafter')")
        page.evaluate("window.handle.setSelection({start:6,end:6});window.insert()")
        page.keyboard.insert_text('next ')
        assert page.evaluate("window.value")=='before\n![[a.svg]]\nnext \nafter'
        # Long note: insertion doesn't drag the viewport to the bottom of an
        # image. Repeated save/index prop echoes preserve both scroll and caret.
        page.evaluate("window.reset(('paragraph\\n\\n').repeat(70))")
        page.evaluate("window.handle.setSelection({start:360,end:360})")
        page.wait_for_timeout(100)
        old_top=page.evaluate("window.view().scrollDOM.scrollTop")
        page.evaluate("window.insert()")
        page.wait_for_timeout(200)
        assert abs(page.evaluate("window.view().scrollDOM.scrollTop")-old_top)<3, 'insertion must preserve viewport anchor'
        page.keyboard.insert_text('stable text')
        page.wait_for_timeout(100)
        before_echo=page.evaluate("({top:window.view().scrollDOM.scrollTop,selection:window.handle.getSelection()})")
        for _ in range(20):
            page.evaluate("window.refresh()")
            page.evaluate("new Promise(requestAnimationFrame)")
        after_echo=page.evaluate("({top:window.view().scrollDOM.scrollTop,selection:window.handle.getSelection()})")
        assert before_echo==after_echo, (before_echo,after_echo)
        for _ in range(20):
            page.keyboard.insert_text('x')
            page.evaluate("window.refresh()")
            page.evaluate("new Promise(requestAnimationFrame)")
        assert page.evaluate("window.value.includes('stable text'+'x'.repeat(20))"), 'typing cannot jump before media'
        before_echo=page.evaluate("({top:window.view().scrollDOM.scrollTop,selection:window.handle.getSelection()})")
        for _ in range(10):
            page.evaluate("window.reconfigure()")
            page.evaluate("new Promise(requestAnimationFrame)")
        assert before_echo==page.evaluate("({top:window.view().scrollDOM.scrollTop,selection:window.handle.getSelection()})"), 'real presentation reconfiguration must preserve the viewport too'
        assert not errors, errors
        print('PASS: insertion landing/anchor, stable media, media range selection both directions, 20 save echoes and 20 input echoes')
    finally:
        browser.close()
        urlopen('http://127.0.0.1:18763/__close').close()
