"""R6 actual CM commands, full production width CSS, filename and page workflows."""
from playwright.sync_api import sync_playwright
from urllib.request import urlopen
import os
from pathlib import Path

with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    try:
        page=browser.new_page(viewport={'width':1900,'height':1000})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:18763',wait_until='networkidle')
        page.evaluate("document.querySelector('#root').classList.add('note-content-area');document.querySelector('#root').style.width='1800px'")
        def reset(text):
            page.evaluate('(text)=>window.reset(text)',text)
            page.wait_for_timeout(60)
        def pref(name):
            r=page.locator('.cm-content').bounding_box()
            page.mouse.click(r['x']+3,r['y']+15,button='right')
            page.get_by_role('menuitemcheckbox',name=name,exact=True).click()
        reset('')
        page.locator('.cm-content').click()
        # Same commands used by the context menu, separated by actual Enter.
        for level in range(1,7):
            page.evaluate('(level)=>window.command("heading"+level)',level)
            page.keyboard.type('Section'+str(level))
            page.keyboard.press('Enter')
        page.keyboard.type('deep body')
        page.keyboard.press('Enter')
        page.evaluate('window.command("heading1")')
        page.keyboard.type('Next')
        page.keyboard.press('Enter')
        page.keyboard.type('next body')
        expected=page.evaluate('window.value')
        assert '###### Section6' in expected,expected
        assert page.locator('.lr-live-line-heading').count()==7
        assert '#' not in page.locator('.lr-live-line-heading.h1').first.inner_text()
        first=page.get_by_role('button',name='折叠章节',exact=True).first
        page.mouse.move(1850,800)
        assert first.evaluate('e=>getComputedStyle(e).opacity')=='0'
        page.locator('.lr-live-line-heading.h1').first.hover()
        assert first.evaluate('e=>getComputedStyle(e).opacity')=='1'
        first.click()
        assert 'Section2' not in page.locator('.cm-content').inner_text()
        assert 'Next' in page.locator('.cm-content').inner_text()
        page.get_by_role('button',name='展开章节',exact=True).first.click()
        assert 'Section6' in page.locator('.cm-content').inner_text()
        assert page.evaluate('window.value')==expected
        page.locator('.lr-live-line-heading.h3').click()
        assert '###' in page.locator('.lr-live-line-heading.h3').inner_text()
        page.evaluate('document.activeElement.blur()')
        assert '#' not in page.locator('.lr-live-line-heading.h3').inner_text()
        page.locator('.lr-live-line-heading.h3').click()
        page.evaluate('window.command("paragraph")')
        assert '\nSection3\n' in page.evaluate('window.value')
        wide=page.locator('.cm-content').bounding_box()['width']
        assert wide>1750,wide
        pref('限制行宽')
        narrow=page.locator('.cm-content').bounding_box()['width']
        assert narrow<970 and wide-narrow>700,(wide,narrow)
        pref('限制行宽')
        assert page.locator('.cm-content').bounding_box()['width']>1750
        # New note naming remains available even with inline-title preference off.
        reset('body stays untouched')
        page.evaluate('window.beginNaming()')
        name=page.locator('.note-inline-title input')
        name.wait_for()
        page.wait_for_timeout(60)
        assert name.evaluate('e=>document.activeElement===e && e.selectionStart===0 && e.selectionEnd===e.value.length')
        name.fill('Renamed')
        name.press('Enter')
        page.wait_for_timeout(100)
        assert page.evaluate('window.renameCalls')==[['fixture','Renamed']]
        assert page.evaluate('window.value')=='body stays untouched'
        assert name.count()==0
        pref('页面内标题')
        name.fill('conflict')
        page.evaluate('window.renameFailure=true')
        name.press('Enter')
        assert page.locator('.note-filename-error').inner_text()=='名称已存在'
        assert page.evaluate('window.value')=='body stays untouched'
        name.fill('cancelled'); name.press('Escape')
        assert name.input_value()=='fixtureRenamed'
        calls=page.evaluate('window.workflow({conflicts:2})')
        creates=[c[1] for c in calls if c[0]=='create']
        assert [c['title'] for c in creates]==['未命名','未命名 1','未命名 2'],calls
        assert all(c['content']=='' and c['parentRelativePath']=='folder' for c in creates)
        assert calls[-1]==['naming','real-vault:folder/未命名 2.md'],calls
        calls=page.evaluate('window.workflow({fail:true})')
        assert not any(c[0] in ['select','naming'] for c in calls),calls
        calls=page.evaluate('window.workflow({rename:true})')
        assert [c[0] for c in calls]==['flush','rename','remap','tree'],calls
        assert next(c[1] for c in calls if c[0]=='tree')=={'silent':True,'fresh':True},calls
        calls=page.evaluate('window.workflow({rename:true,dirty:true})')
        assert [c[0] for c in calls]==['flush','error'],calls
        calls=page.evaluate('window.workflow({rename:true,fail:true})')
        assert [c[0] for c in calls]==['flush','rename','error'],calls
        if os.environ.get('KNOWLEDGE_UX_EVIDENCE_DIR'):
            folder=Path(os.environ['KNOWLEDGE_UX_EVIDENCE_DIR']); folder.mkdir(parents=True,exist_ok=True)
            reset('# 一级章节\n正文\n## 二级章节\n子章节正文\n### 三级章节\n更多内容\n# 下一章\n独立内容')
            page.locator('.cm-content').click()
            page.keyboard.press('Control+End')
            page.get_by_role('button',name='折叠章节',exact=True).nth(1).click()
            page.screenshot(path=str(folder/'heading-filename-r6.png'))
        assert not errors,errors
        print('PASS R6: H1–H6/Enter hierarchy/body/syntax/hover/full width, selected filename/error/cancel, blank creation collisions and rename guards')
    finally:
        browser.close()
        urlopen('http://127.0.0.1:18763/__close').read()
