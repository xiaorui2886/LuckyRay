"""R5 real editor display preferences, heading folds and image backdrop dismissal."""
from playwright.sync_api import sync_playwright
import json
from urllib.request import urlopen
import os
from pathlib import Path

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    try:
        page = browser.new_page(viewport={'width': 1300, 'height': 850})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:18763', wait_until='networkidle')
        page.evaluate("document.querySelector('#root').style.width='1280px'")
        def reset(text):
            page.evaluate('(text)=>window.reset(text)', text)
            page.wait_for_timeout(120)
        def preference(label):
            r = page.locator('.cm-scroller').bounding_box()
            page.mouse.click(r['x']+r['width']-4, r['y']+90, button='right')
            menu = page.get_by_role('menu', name='笔记显示设置')
            assert menu.is_visible()
            menu.get_by_role('menuitemcheckbox', name=label, exact=True).click()
            page.wait_for_timeout(150)
        reset('# One\nbody one\n## Child\nchild body\n# Two\nbody two\n')
        assert page.get_by_role('button', name='折叠章节', exact=True).first.is_visible()
        assert page.get_by_role('button', name='折叠章节', exact=True).count()==3
        page.get_by_role('button', name='折叠章节', exact=True).first.click()
        assert 'body one' not in page.locator('.cm-content').inner_text()
        assert 'Child' not in page.locator('.cm-content').inner_text()
        assert 'Two' in page.locator('.cm-content').inner_text()
        assert page.evaluate('window.value').startswith('# One\nbody one')
        page.evaluate('window.refresh(); window.reconfigure()')
        page.wait_for_timeout(100)
        assert 'body one' not in page.locator('.cm-content').inner_text()
        page.get_by_role('button', name='展开章节', exact=True).first.click()
        assert 'child body' in page.locator('.cm-content').inner_text()
        # Nested folds and media replacements must coexist, including fences
        # whose contents resemble headings but are not Markdown sections.
        reset('# Parent\n![[a.svg|300]]\n## Child\nchild\n# Next\n```text\n# fake\n```\nend')
        page.get_by_role('button',name='折叠章节',exact=True).nth(1).click()
        page.get_by_role('button',name='折叠章节',exact=True).first.click()
        assert page.locator('.note-media').count()==0
        assert 'Next' in page.locator('.cm-content').inner_text()
        page.get_by_role('button',name='展开章节',exact=True).first.click()
        assert page.locator('.note-media').count()==1
        assert page.get_by_role('button',name='展开章节',exact=True).count()==1
        reset('# Real\nbody\n```text\n# fake\n```\n')
        assert page.get_by_role('button',name='折叠章节',exact=True).count()==1  # Only Real; the code preview's # fake is not a heading.
        reset('plain\n![[a.svg|300]]\nafter')
        card=page.locator('.note-media')
        card.click(position={'x':70,'y':70})
        card.click(position={'x':70,'y':70})
        page.wait_for_selector('.note-image-viewer[open]')
        image=page.locator('.note-image-viewer-stage img')
        image.click()
        assert page.locator('.note-image-viewer[open]').count()==1
        image.dblclick()
        assert page.locator('.note-image-viewer-stage').get_attribute('data-zoomed')=='true'
        r=image.bounding_box()
        page.mouse.move(650,420); page.mouse.down(); page.mouse.move(100,420,steps=5); page.mouse.up()
        assert page.locator('.note-image-viewer[open]').count()==1
        page.get_by_role('button',name='恢复图片适配大小').click()
        stage=page.locator('.note-image-viewer-stage').bounding_box()
        page.mouse.click(stage['x']+6,stage['y']+20)
        assert page.locator('.note-image-viewer').count()==0
        reset('hello\nworld\nlast')
        original=page.evaluate('window.value')
        width_before=page.locator('.cm-content').bounding_box()['width']
        preference('限制行宽')
        width_after=page.locator('.cm-content').bounding_box()['width']
        assert width_after <= 921 and width_before-width_after>200,(width_before,width_after)
        preference('行号')
        assert page.locator('.cm-lineNumbers').inner_text().split()==['1','2','3']
        preference('页面内标题')
        assert page.locator('.note-inline-title input').input_value()=='fixture1'
        alignment=page.evaluate('''() => {
          const line=document.querySelector('.cm-line').getBoundingClientRect();
          const number=[...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].find(el=>el.getBoundingClientRect().height>0).getBoundingClientRect();
          return {line:line.top,number:number.top};
        }''')
        assert abs(alignment['line']-alignment['number'])<2,alignment
        assert page.evaluate('window.value')==original
        # A right click on actual text remains an editor operation, not a
        # display menu, and a margin menu itself doesn't move the selection.
        page.evaluate('window.handle.setSelection({start:2,end:2})')
        before=page.evaluate('window.handle.getSelection()')
        r=page.locator('.cm-scroller').bounding_box()
        page.mouse.click(r['x']+r['width']-4,r['y']+100,button='right')
        page.keyboard.press('Escape')
        assert page.evaluate('window.handle.getSelection()')==before
        if os.environ.get('KNOWLEDGE_UX_EVIDENCE_DIR'):
            folder=Path(os.environ['KNOWLEDGE_UX_EVIDENCE_DIR']); folder.mkdir(parents=True,exist_ok=True)
            reset('# A readable note\nHeading sections can collapse without changing Markdown.\n## Nested section\n![[a.svg|320]]\n# Next section\nThe next section stays visible.')
            page.get_by_role('button',name='折叠章节',exact=True).nth(1).click()
            page.screenshot(path=str(folder/'display-heading-fold.png'))
        saved=json.loads(page.evaluate("localStorage.getItem('luckyray.notes.display.v1')"))
        assert all(saved.values()), saved
        page.reload(wait_until='networkidle')
        assert page.locator('.cm-editor').get_attribute('data-limit-width')=='true'
        assert page.locator('.cm-lineNumbers').count()==1
        assert page.locator('.note-inline-title').count()==1
        preference('行号'); preference('页面内标题'); preference('限制行宽')
        assert page.locator('.cm-lineNumbers').count()==0
        assert page.locator('.note-inline-title').count()==0
        assert not errors,errors
        print('PASS R5: folds, retained content, viewer blank/drag, real width/line numbers/title, persistence')
    finally:
        browser.close()
        urlopen('http://127.0.0.1:18763/__close').read()
