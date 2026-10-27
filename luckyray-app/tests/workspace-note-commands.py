from playwright.sync_api import sync_playwright
import json

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='msedge')
    page=browser.new_page(viewport={'width':1280,'height':800})
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto('http://127.0.0.1:1427/tests/fixtures/workspace-tools.html')
    page.locator('[data-workspace-tab="A"]').click()
    editor=page.locator('[data-workspace-view="A"] .cm-content')
    editor.wait_for(state='visible');editor.click()
    page.keyboard.press('Control+Home');page.keyboard.press('Control+a');page.keyboard.insert_text('中文正文')
    page.keyboard.press('Control+Home');page.keyboard.press('Shift+End');page.keyboard.press('Control+b')
    read='window.documentSessions.get({libraryId:"test",resourceId:"A.md"},()=>{throw Error("missing")}).getSnapshot().content'
    page.wait_for_function(read+'==="**中文正文**"')
    page.keyboard.press('Control+z');page.wait_for_function(read+'==="中文正文"')
    page.keyboard.press('Control+y');page.wait_for_function(read+'==="**中文正文**"')
    editor.click(button='right')
    page.locator('.editor-ctx-item-react.has-sub').filter(has_text='段落设置').hover()
    page.get_by_role('button',name='6 级标题',exact=True).click()
    page.wait_for_function(read+'.startsWith("###### ")')
    page.keyboard.press('Control+z');page.wait_for_function(read+'==="**中文正文**"')
    editor.click();page.keyboard.press('Control+a')
    table='| 名称 | 数量 |\n| --- | --- |\n| 中文 | 2 |\n| 茶叶 | 10 |\n\n后文'
    page.keyboard.insert_text(table);page.keyboard.press('Control+End')
    cell=page.locator('[data-workspace-view="A"] [data-lr-table-line-offset="2"][data-lr-table-column="0"]')
    cell.wait_for(state='visible');cell.click(button='right')
    page.locator('.editor-ctx-item-react.has-sub').filter(has=page.locator(':scope > span',has_text='行')).last.hover()
    page.get_by_role('button',name='在下方新增行',exact=True).click()
    page.wait_for_function(read+'.includes("|  |  |")')
    page.keyboard.press('Control+z');page.wait_for_function(read+'==='+json.dumps(table))
    assert not errors,errors
    print(json.dumps({'errors':errors,'productionSharedMenu':True,'headingSix':True,'formatUndoRedo':True,'tableInsertUndo':True}))
    browser.close()
