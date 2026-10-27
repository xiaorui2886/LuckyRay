from playwright.sync_api import sync_playwright
import json

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='msedge')
    page=browser.new_page(viewport={'width':1400,'height':850})
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto('http://127.0.0.1:1427/tests/fixtures/workspace-materials.html')
    page.wait_for_load_state('networkidle')
    a=page.locator('[data-workspace-view="A"]')
    b=page.locator('[data-workspace-view="B"]')
    a.get_by_text('A 图片 1',exact=True).first.wait_for(state='attached')
    b.get_by_text('B 图片 1',exact=True).first.wait_for(state='attached')
    a.get_by_role('textbox',name='搜索当前素材视图').fill('1')
    page.wait_for_timeout(500)
    assert not a.get_by_text('A 图片 2',exact=True).count()
    assert b.get_by_text('B 图片 2',exact=True).count()
    await_switch=page.evaluate('window.changeGlobalLibrary()')
    a.get_by_role('textbox',name='搜索当前素材视图').fill('2')
    page.wait_for_timeout(500)
    assert a.get_by_text('A 图片 2',exact=True).count()
    assert not a.get_by_text('B 图片 2',exact=True).count()
    assert b.get_by_text('B 图片 1',exact=True).count()
    page.evaluate('window.materialNode=document.querySelector("[data-workspace-view=A] #page-materials-A")')
    page.evaluate('window.workspaceStore.dispatch({type:"move",viewId:"A",targetGroup:"right",edge:"center"})')
    page.wait_for_timeout(150)
    assert page.evaluate('window.materialNode===document.querySelector("[data-workspace-view=A] #page-materials-A")')
    assert a.get_by_role('textbox',name='搜索当前素材视图').input_value()=='2'
    a.locator('[data-asset-id="same-2"]').click()
    page.wait_for_timeout(500)
    page.locator('.detail-input-react').first.fill('A renamed 2')
    page.locator('.detail-primary-btn-react').click()
    page.wait_for_timeout(400)
    writes=page.evaluate('window.calls.filter(c=>c.action.op==="update" && "name" in c.action.patch)')
    assert writes and all(call['libraryId']=='A' for call in writes),writes
    page.keyboard.press('Escape')
    # Detached filter remains pinned to A while focus/global library is B.
    page.evaluate('window.openTool("material-filter")')
    filter_panel=page.get_by_role('region',name='素材筛选',exact=True)
    filter_panel.get_by_role('button',name='固定对象',exact=True).click()
    page.locator('[data-workspace-tab="B"]').click()
    filter_panel.get_by_role('textbox',name='筛选面板搜索素材').fill('1')
    page.wait_for_timeout(350)
    assert a.locator('input[aria-label="搜索当前素材视图"]').input_value()=='1'
    assert b.locator('input[aria-label="搜索当前素材视图"]').input_value()==''
    filter_panel.get_by_role('combobox',name='素材筛选位置').select_option('left')
    page.locator('[data-workspace-tab="A"]').click()
    a.locator('[data-asset-id="same-1"]').click()
    page.keyboard.press('Escape')
    page.evaluate('window.openTool("material-inspector")')
    inspector=page.get_by_role('region',name='素材检查器',exact=True)
    inspector.locator('.detail-input-react').first.wait_for(state='visible')
    inspector.get_by_role('button',name='固定对象',exact=True).click()
    page.locator('[data-workspace-tab="B"]').click()
    inspector.locator('.detail-input-react').first.fill('Pinned A only')
    inspector.locator('.detail-primary-btn-react').click()
    page.wait_for_timeout(400)
    pinned_writes=page.evaluate('window.calls.filter(c=>c.action.op==="update" && c.action.patch.name==="Pinned A only")')
    assert pinned_writes and all(call['libraryId']=='A' for call in pinned_writes),pinned_writes
    # Moving a panel must preserve unsaved form input and the content editor DOM.
    inspector.locator('.detail-input-react').first.fill('unsaved inspector draft')
    page.evaluate('window.inspectorInput=document.querySelector(".workspace-tool-body[aria-label=素材检查器] .detail-input-react")')
    inspector.get_by_role('combobox',name='素材检查器位置').select_option('float')
    assert inspector.locator('.detail-input-react').first.input_value()=='unsaved inspector draft'
    assert page.evaluate('window.inspectorInput===document.querySelector(".workspace-tool-body[aria-label=素材检查器] .detail-input-react")')
    inspector.get_by_role('button',name='关闭素材检查器',exact=True).click()
    filter_panel.get_by_role('button',name='关闭素材筛选',exact=True).click()
    page.locator('[data-workspace-tab="A"]').click()
    page.set_viewport_size({'width':650,'height':720})
    page.wait_for_timeout(150)
    assert a.locator('img').first.evaluate('(img)=>img.naturalWidth>0&&img.width>=100'), 'narrow panes retain usable thumbnail width'
    page.screenshot(path='output/playwright/workspace-p0/material-scopes.png')
    print(json.dumps({'errors':errors,'sameIdLibrariesRemainIsolated':True,'filterRetainedOnMove':True,'renameWrites':writes,'pinnedInspectorWrites':pinned_writes,'inspectorDraftRetainedOnDock':True},ensure_ascii=True))
    assert not errors
    browser.close()
