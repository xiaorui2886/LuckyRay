from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    try:
        page=browser.new_page()
        page.add_init_script("localStorage.setItem('luckyray.notes.display.v1',JSON.stringify({inlineTitle:true}))")
        page.goto('http://127.0.0.1:18763',wait_until='networkidle')
        page.evaluate('window.openNamingNote()')
        page.wait_for_timeout(100)
        name=page.get_by_role('textbox',name='笔记文件名')
        assert name.evaluate('e=>document.activeElement===e && e.selectionStart===0 && e.selectionEnd===e.value.length')
        name.fill('name2')
        name.press('Enter')
        name.press('End')
        name.press('3')
        name.press('Enter')
        page.wait_for_timeout(500)
        assert name.input_value()=='name23',{'display':name.input_value(),'calls':page.evaluate('window.renameCalls')}
        assert page.evaluate("window.fixtureId==='real-vault:name23.md'")
        print('PASS late name selection and queued rename preserving in-flight typing')
    finally:
        browser.close()
