import json
from pathlib import Path
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='msedge')
    page = browser.new_page(viewport={'width':1280,'height':800})
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto('http://127.0.0.1:1427/tests/fixtures/workspace-component.html')
    page.wait_for_load_state('networkidle')
    editor=page.locator('[data-workspace-view="note-a"] .cm-content')
    editor.wait_for(state='visible')
    editor.click()
    page.keyboard.press('Control+Home')
    page.keyboard.insert_text('工作区输入保留')
    page.evaluate('window.editorBefore = document.querySelector("[data-workspace-view=note-a] .cm-content")')
    for edge in ['right','bottom','left','top']:
        page.evaluate('''edge => {const s=window.workspaceStore,l=s.getSnapshot();const g=(function walk(n){return n.kind==='group'?n:[walk(n.first),walk(n.second)].find(Boolean)})(l.root); s.dispatch({type:'move',viewId:'note-a',targetGroup:g.id,edge,groupId:crypto.randomUUID(),splitId:crypto.randomUUID()});}''',edge)
        page.wait_for_timeout(100)
        assert page.evaluate('window.editorBefore===document.querySelector("[data-workspace-view=note-a] .cm-content")')
        page.evaluate('window.workspaceStore.undo()')
    assert page.evaluate('window.drafts["note-a"].startsWith("工作区输入保留")')
    editor.focus()
    page.keyboard.press('Control+z')
    page.wait_for_timeout(100)
    assert page.evaluate('!window.drafts["note-a"].startsWith("工作区输入保留")')
    page.keyboard.press('Control+y')
    page.wait_for_timeout(100)
    assert page.evaluate('window.drafts["note-a"].startsWith("工作区输入保留")')
    # A real pointer move, canceled with Escape, must not commit a split.
    before=page.evaluate('JSON.stringify(window.workspaceStore.getSnapshot())')
    tab=page.locator('[data-workspace-tab="note-a"]')
    bounds=tab.bounding_box()
    page.mouse.move(bounds['x']+15,bounds['y']+15);page.mouse.down();page.mouse.move(1100,450,steps=12)
    page.keyboard.press('Escape');page.mouse.up()
    assert page.evaluate('JSON.stringify(window.workspaceStore.getSnapshot())')==before
    # Commit a real edge drag. The editor DOM, draft and selection stay alive.
    bounds=tab.bounding_box()
    page.mouse.move(bounds['x']+15,bounds['y']+15);page.mouse.down();page.mouse.move(1270,420,steps=12)
    assert page.locator('.workspace-drop-preview').is_visible()
    page.mouse.up();page.wait_for_timeout(150)
    assert page.locator('[data-workspace-group]').count()==2
    assert page.evaluate('window.editorBefore===document.querySelector("[data-workspace-view=note-a] .cm-content")')
    layout_before_resize=page.evaluate('JSON.stringify(window.workspaceStore.getSnapshot())')
    divider=page.get_by_role('separator',name='调整分屏尺寸')
    handle=divider.bounding_box()
    page.mouse.move(handle['x']+3,handle['y']+100);page.mouse.down();page.mouse.move(handle['x']-140,handle['y']+100,steps=8)
    assert abs(divider.bounding_box()['x']-handle['x'])>80
    page.keyboard.press('Escape');page.mouse.up()
    assert page.evaluate('JSON.stringify(window.workspaceStore.getSnapshot())')==layout_before_resize
    page.evaluate('window.workspaceStore.undo()')
    page.locator('[data-workspace-tab="materials-a"]').click()
    page.wait_for_timeout(600)
    assert page.locator('[data-workspace-view="materials-a"] #page-materials').is_visible()
    page.locator('[data-workspace-tab="note-a"]').click()
    assert page.evaluate('window.editorBefore===document.querySelector("[data-workspace-view=note-a] .cm-content")')
    # Close -> layout undo retains the editor instance and its undo history.
    page.evaluate('window.workspaceStore.dispatch({type:"close",viewId:"note-a"});window.workspaceStore.undo()')
    assert page.evaluate('window.editorBefore===document.querySelector("[data-workspace-view=note-a] .cm-content")')
    for width in [680,980,1920]:
        page.set_viewport_size({'width':width,'height':800});page.wait_for_timeout(100)
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    output=Path('output/playwright/workspace-p0');output.mkdir(parents=True,exist_ok=True)
    page.screenshot(path=str(output/'retained-note.png'))
    result={'mounts':page.evaluate('window.mounts'),'unmounts':page.evaluate('window.unmounts'),'errors':errors,'actualNative':False}
    print(json.dumps(result,ensure_ascii=False))
    assert not errors
    browser.close()
