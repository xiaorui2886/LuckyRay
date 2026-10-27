"""Production editor: folded boundary and retained filename / rename interactions."""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    try:
        page = browser.new_page(viewport={'width':1400,'height':1000})
        page.add_init_script("localStorage.setItem('luckyray.notes.display.v1',JSON.stringify({inlineTitle:true,limitWidth:true,lineNumbers:false}))")
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:18763',wait_until='networkidle')
        navigation=page.evaluate('window.checkPendingFilenameNavigation()')
        assert navigation=={'reused':False,'calls':[['real-vault:A.md','A renamed']],'finished':['real-vault:A renamed.md']},navigation
        assert page.evaluate('window.treeProjection({renaming:true})')==[]
        fresh=page.evaluate('window.treeProjection({renaming:true,fresh:true})')
        assert 'notes' in fresh and not any(isinstance(c,list) and c[0] in ['id','content'] for c in fresh),fresh
        normal=page.evaluate('window.treeProjection({})')
        assert ['id',None] in normal,normal
        page.evaluate("window.reset('# Heading\\nhidden text\\n## Child\\nhidden child')")
        page.get_by_role('button',name='折叠章节',exact=True).first.click()
        r=page.locator('.cm-content').bounding_box()
        page.mouse.click(r['x']+400,r['y']+450)
        page.wait_for_timeout(80)
        assert page.evaluate('window.view().state.selection.main.head === window.value.length')
        assert '#' not in page.locator('.lr-live-line-heading').inner_text()
        placeholder=page.locator('.cm-foldPlaceholder').bounding_box()
        caret=page.evaluate('(()=>{const v=window.view();return v.coordsAtPos(v.state.selection.main.head)})()')
        assert caret['left']>=placeholder['x']+placeholder['width']-2,(caret,placeholder)
        for key in ['ArrowDown','ArrowUp','ArrowRight','ArrowLeft','ArrowRight','ArrowDown']:
            page.keyboard.press(key)
            assert page.locator('.cm-foldPlaceholder').count()==1,key
        page.mouse.click(r['x']+400,r['y']+450)
        page.keyboard.press('Enter')
        assert page.locator('.cm-foldPlaceholder').count()==0
        assert 'hidden child' in page.locator('.cm-content').inner_text()
        print('PASS folded boundary, arrow navigation and Enter-only unfold')
        page.evaluate('window.openNamingNote()')
        name=page.get_by_role('textbox',name='笔记文件名')
        page.wait_for_timeout(100)
        assert name.evaluate('e=>document.activeElement===e && e.selectionStart===0 && e.selectionEnd===e.value.length')
        page.evaluate("window.reset('body\\n![[a.svg]]\\n# Section\\nkeep me')")
        page.wait_for_timeout(100)
        page.evaluate("window.savedView=window.view();window.savedInput=document.querySelector('.note-inline-title input');window.savedImage=document.querySelector('.note-media img')")
        name.fill('快速改名2')
        name.press('Enter')
        # Type another character while the filesystem reply is still in flight.
        name.press('End')
        name.press('3')
        name.press('Enter')
        page.wait_for_timeout(500)
        assert name.input_value()=='快速改名23',name.input_value()
        assert page.evaluate("window.fixtureId==='real-vault:快速改名23.md'")
        assert page.evaluate('window.savedView===window.view()')
        assert page.evaluate("window.savedInput===document.querySelector('.note-inline-title input')")
        assert page.evaluate("window.savedImage===document.querySelector('.note-media img')")
        assert page.evaluate('window.value').startswith('body\n![[a.svg]]')
        assert not errors,errors
        print('PASS late naming auto-select; rapid asynchronous renames keep input/editor/media identity and final character')
    finally:
        browser.close()
