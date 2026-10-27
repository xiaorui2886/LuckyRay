"""Blank-area hit testing around folded headings, using the production editor."""
from playwright.sync_api import sync_playwright
import os

with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    try:
        page=browser.new_page(viewport={'width':1400,'height':1000})
        page.add_init_script("localStorage.setItem('luckyray.notes.display.v1',JSON.stringify({inlineTitle:true,limitWidth:true,lineNumbers:false}))")
        page.goto('http://127.0.0.1:18763',wait_until='networkidle')
        failures=[]
        for source in ['# 打萨达萨达撒旦\nhidden', '# 打萨达萨达撒旦\nhidden\n', '# Heading\nhidden\n## Child\nchild', 'intro\n# Heading\nhidden']:
            for dx in [5,70,180,320,550]:
                for dy in [25,140,400]:
                    page.evaluate("window.reset('reset')")
                    page.wait_for_timeout(20)
                    page.evaluate('(s)=>window.reset(s)',source)
                    page.wait_for_timeout(35)
                    page.get_by_role('button',name='折叠章节',exact=True).first.click()
                    heading=page.locator('.lr-live-line-heading').first.bounding_box()
                    page.mouse.click(heading['x']+dx,heading['y']+heading['height']+dy)
                    page.wait_for_timeout(35)
                    result=page.evaluate('({pos:window.view().state.selection.main.head,end:window.value.length,folds:document.querySelectorAll(".cm-foldPlaceholder").length})')
                    if result['pos']!=result['end'] or result['folds']!=1 or '#' in page.locator('.lr-live-line-heading').first.inner_text():
                        failures.append([source,dx,dy,result])
            page.evaluate('(s)=>window.reset(s)',source)
        print('blank-click mismatches',len(failures),failures[:10])
        if not os.environ.get('FOLD_DIAGNOSE'):
            assert not failures,failures[:10]
        for body in ['hidden', '![[a.svg]]\nhidden', '## Child\nchild']:
            for key in ['ArrowRight','ArrowLeft','ArrowDown','ArrowUp']:
                page.evaluate("window.reset('reset')")
                page.wait_for_timeout(20)
                page.evaluate('(s)=>window.reset(s)', '# Heading\n'+body+'\n# Next\nnext body')
                page.wait_for_timeout(35)
                page.get_by_role('button',name='折叠章节',exact=True).first.click()
                line=page.locator('.lr-live-line-heading').first
                r=line.bounding_box()
                page.mouse.click(r['x']+45,r['y']+r['height']/2)
                assert '#' in line.inner_text(),'direct heading click must remain editable'
                for _ in range(14):
                    page.keyboard.press(key)
                    assert page.locator('.cm-foldPlaceholder').count()==1,(body,key)
        page.reload(wait_until='networkidle')
        page.evaluate("window.reset('# Heading\\nhidden')")
        page.wait_for_timeout(35)
        page.get_by_role('button',name='折叠章节',exact=True).first.click()
        placeholder=page.locator('.cm-foldPlaceholder').bounding_box()
        page.mouse.click(placeholder['x']+placeholder['width']+70,placeholder['y']+placeholder['height']/2)
        assert page.evaluate('window.view().state.selection.main.head===window.value.length')
        page.keyboard.press('Enter')
        assert page.locator('.cm-foldPlaceholder').count()==0
        print('PASS 60 blank points, editable heading clicks, arrows around hidden media/child headings, right-side click and Enter')
    finally:
        browser.close()
