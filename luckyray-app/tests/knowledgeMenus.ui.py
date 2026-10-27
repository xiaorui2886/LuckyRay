from playwright.sync_api import sync_playwright
from urllib.request import urlopen

with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    try:
        page=browser.new_page(viewport={'width':1300,'height':850})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:18764',wait_until='networkidle')
        folder=page.locator('[data-folder-id="folder"]').first
        for label,action in [('新建笔记','note'),('新建子文件夹','folder')]:
            folder.click(button='right')
            page.get_by_role('menuitem',name=label,exact=True).click()
            assert page.evaluate('window.actions.at(-1)')==[action,'folder']
        for label,expected in [('新建笔记',['note','__uncategorized__']),('新建文件夹',['folder',None])]:
            page.locator('.folder-list').click(button='right',position={'x':150,'y':270})
            page.get_by_role('menuitem',name=label,exact=True).click()
            assert page.evaluate('window.actions.at(-1)')==expected
        for parent in ['folder',None]:
            for label,action in [('新建笔记','note'),('新建文件夹','folder')]:
                page.evaluate('(parent)=>window.docMenu(parent)',parent)
                page.get_by_role('menu',name='document-create').get_by_role('menuitem',name=label,exact=True).click()
                assert page.evaluate('window.actions.at(-1)')==[action,parent]
        page.locator('#preview').get_by_role('button',name='折叠章节').first.click()
        assert 'child body' not in page.locator('.note-preview').inner_text()
        assert 'next body' in page.locator('.note-preview').inner_text()
        page.locator('#preview').get_by_role('button',name='展开章节').click()
        assert 'child body' in page.locator('.note-preview').inner_text()
        r=page.locator('.note-preview').bounding_box()
        for label in ['限制行宽','页面内标题']:
            page.mouse.click(r['x']+4,r['y']+90,button='right')
            page.get_by_role('menuitemcheckbox',name=label,exact=True).click()
        assert page.locator('.note-preview-content').bounding_box()['width']<=840
        assert page.locator('.note-inline-title input').input_value()=='Fixture title'
        assert not errors,errors
        print('PASS R5 tree/document create targets, preview nested folding, preview width/title')
    finally:
        browser.close()
        urlopen('http://127.0.0.1:18764/__close').read()
