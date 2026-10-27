"""R7 folded blank clicks and hard-line preservation, production CM/React/CSS."""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    try:
        page = browser.new_page(viewport={'width': 1900, 'height': 1000})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:18763', wait_until='networkidle')
        page.evaluate("document.querySelector('#root').classList.add('note-content-area');document.querySelector('#root').style.width='1800px'")
        def reset(text):
            page.evaluate('(text)=>window.reset(text)', text)
            page.wait_for_timeout(100)
        reset('# Fold me\nhidden paragraph\n## Nested\nhidden nested text')
        page.get_by_role('button', name='折叠章节', exact=True).first.click()
        assert 'hidden paragraph' not in page.locator('.cm-content').inner_text()
        r = page.locator('.cm-content').bounding_box()
        page.mouse.click(r['x'] + 350, r['y'] + 300)
        page.wait_for_timeout(100)
        assert 'hidden paragraph' not in page.locator('.cm-content').inner_text(), 'blank click expanded hidden chapter'
        page.locator('.cm-foldPlaceholder').click()
        assert 'hidden paragraph' in page.locator('.cm-content').inner_text()
        page.get_by_role('button', name='折叠章节', exact=True).first.click()
        page.get_by_role('button', name='展开章节', exact=True).first.click()
        assert 'hidden nested text' in page.locator('.cm-content').inner_text()
        for text in ['![[a.svg]]\nnext line', '![[a.svg]]\n\nnext paragraph', '![[a.svg]]inline text\nnext line', 'before ![[a.svg]]\nnext line', '![[a.svg|300]]\nnext line', '![a](a.svg)\nnext line', '![a|300](a.svg)\nnext line', '![[a.svg]]\n![[a.svg|300]]\nnext line']:
            reset(text)
            for _ in range(2):
                card = page.locator('.lr-live-asset-card').last.bounding_box()
                last = page.locator('.cm-line').last.bounding_box()
                assert last['y'] >= card['y'] + card['height'] - 1, (text, card, last)
                assert page.evaluate('window.value') == text
                r = page.locator('.cm-content').bounding_box()
                page.mouse.click(r['x'] + 3, r['y'] + 15, button='right')
                page.get_by_role('menuitemcheckbox', name='限制行宽', exact=True).click()
        reset('![[a.svg|300]]')
        page.locator('.cm-content').click()
        page.keyboard.press('Control+End')
        page.keyboard.press('Enter')
        page.keyboard.type('typed after Enter')
        assert '\ntyped after Enter' in page.evaluate('window.value'), page.evaluate('window.value')
        assert not errors, errors
        print('PASS R7: blank click retains folds, explicit arrows/ellipsis expand; media hard newlines survive both widths')
    finally:
        browser.close()
