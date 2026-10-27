from playwright.sync_api import sync_playwright
import json

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='msedge')
    page=browser.new_page(viewport={'width':1280,'height':800})
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto('http://127.0.0.1:1427/tests/fixtures/workspace-customization.html')
    page.get_by_role('button',name='自定义导航',exact=True).click()
    dialog=page.get_by_role('dialog',name='自定义导航')
    dialog.get_by_role('checkbox',name='素材库',exact=True).uncheck()
    dialog.get_by_role('button',name='上移工作区',exact=True).click()
    dialog.get_by_role('button',name='应用',exact=True).click()
    saved=page.evaluate('window.workspaceStore.getSnapshot().presentation.navigation')
    assert saved['space']['order'].index('workspace')<saved['space']['order'].index('graph')
    assert saved['space']['hidden']==['materials']
    page.get_by_role('button',name='自定义工具栏',exact=True).click()
    dialog=page.get_by_role('dialog',name='自定义工具栏')
    dialog.get_by_role('checkbox',name='添加图谱',exact=True).uncheck()
    dialog.get_by_role('button',name='上移添加素材',exact=True).click()
    dialog.get_by_role('button',name='应用',exact=True).click()
    assert not page.get_by_role('button',name='添加图谱',exact=True).count()
    assert page.evaluate('window.workspaceStore.getSnapshot().presentation.navigation')==saved
    page.reload()
    page.get_by_role('button',name='自定义导航',exact=True).wait_for(state='visible')
    assert not page.get_by_role('button',name='添加图谱',exact=True).count()
    assert page.evaluate('window.workspaceStore.getSnapshot().presentation.navigation')==saved
    page.get_by_role('button',name='自定义导航',exact=True).click()
    dialog=page.get_by_role('dialog',name='自定义导航')
    for box in dialog.get_by_role('checkbox').all():box.uncheck()
    dialog.get_by_role('button',name='应用',exact=True).click()
    page.locator('.sidebar-footer .nav-item').filter(has_text='设置').wait_for(state='visible')
    page.get_by_role('button',name='自定义导航',exact=True).click()
    dialog=page.get_by_role('dialog',name='自定义导航')
    dialog.get_by_role('button',name='恢复默认',exact=True).click()
    dialog.get_by_role('button',name='取消',exact=True).click()
    assert page.evaluate('window.workspaceStore.getSnapshot().presentation.navigation.space.hidden.length')==7
    page.get_by_role('button',name='自定义导航',exact=True).click()
    dialog.get_by_role('button',name='恢复默认',exact=True).click()
    dialog.get_by_role('button',name='应用',exact=True).click()
    assert page.evaluate('window.workspaceStore.getSnapshot().presentation.navigation.space.hidden')==[]
    assert not page.get_by_role('button',name='添加图谱',exact=True).count()
    page.screenshot(path='output/playwright/workspace-p0/customization.png')
    assert not errors,errors
    print(json.dumps({'errors':errors,'navigationOrder':True,'sharedStore':True,'persistent':True,'hideAllRecoverable':True,'cancelDoesNotApply':True}))
    browser.close()
