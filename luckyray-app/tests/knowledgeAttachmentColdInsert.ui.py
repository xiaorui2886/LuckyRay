"""First-ever decode at the bottom, not just a cached insert mid-document."""
from playwright.sync_api import sync_playwright
from urllib.request import urlopen

with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    try:
        page=browser.new_page(viewport={'width':1000,'height':800})
        page.goto('http://127.0.0.1:18763',wait_until='networkidle')
        for warm in [False,True]:
            page.evaluate("window.reset(('paragraph\\n\\n').repeat(100))")
            page.wait_for_timeout(100)
            page.evaluate("const p=window.value.length;window.handle.setSelection({start:p,end:p})")
            page.wait_for_timeout(100)
            before=page.evaluate('window.view().scrollDOM.scrollTop')
            url='/cold.svg?v='+str(warm)
            if warm: page.evaluate('(url)=>window.warm(url)',url)
            page.evaluate('(url)=>window.insertCold(url)',url)
            samples=[]
            for _ in range(14):
                page.wait_for_timeout(70)
                samples.append(page.evaluate('window.view().scrollDOM.scrollTop'))
            print('cold bottom insert',warm,before,samples)
            if warm: assert max(abs(s-before) for s in samples)<3,(before,samples)
        # Actual prepare + flushSync publication projection + range commit.
        for n in range(3):
            page.evaluate("window.reset(('![[a.svg]]\\n').repeat(10)+'end')")
            page.wait_for_timeout(300)
            page.evaluate("const p=window.value.length;window.handle.setSelection({start:p,end:p})")
            page.wait_for_timeout(150)
            before=page.evaluate('window.view().scrollDOM.scrollTop')
            page.evaluate('void window.publish().catch(e=>window.publishError=String(e))')
            samples=[]
            heights=[]
            for _ in range(20):
                page.wait_for_timeout(70)
                samples.append(page.evaluate('window.view().scrollDOM.scrollTop'))
                heights.append(page.evaluate('''() => {const e=document.querySelector('[data-asset-target="cold.svg"]');return e?e.getBoundingClientRect().height:null}'''))
            print('publication at image-rich bottom',n,before,samples,heights)
            assert max(abs(s-before) for s in samples)<3,(before,samples)
            assert page.evaluate("window.value.includes('![[cold.svg]]')"), page.evaluate('window.publishError||window.value')
            assert any(h is not None for h in heights), 'must observe newly inserted attachment'
            assert all(h is None or h>900 for h in heights),('first-paint collapse/growth',heights)
        # A file watcher/index refresh changes resolved URLs while old images
        # above the viewport are still present in the document.
        page.evaluate("window.reset(('![[a.svg]]\\n').repeat(10)+'end')")
        page.wait_for_timeout(150)
        page.evaluate("const p=window.value.length;window.handle.setSelection({start:p,end:p})")
        page.wait_for_timeout(150)
        before=page.evaluate('window.view().scrollDOM.scrollTop')
        anchor_top=page.locator('.cm-line').filter(has_text='end').last.bounding_box()['y']
        page.evaluate('window.invalidateSource()')
        samples=[]
        anchors=[]
        for _ in range(16):
            page.wait_for_timeout(60)
            samples.append(page.evaluate('window.view().scrollDOM.scrollTop'))
            anchors.append(page.locator('.cm-line').filter(has_text='end').last.bounding_box()['y'])
        print('watcher URL refresh',before,samples)
        # Virtual offscreen estimates may change scrollTop a few pixels; the
        # visible content anchor must not move during or after the reload.
        assert max(abs(y-anchor_top) for y in anchors)<3,('watcher jump',anchor_top,anchors)
        assert page.locator('.note-media img').evaluate_all('(els)=>els.every(e=>e.complete&&e.naturalHeight===440&&e.src.endsWith("v=1"))')
    finally:
        browser.close()
        urlopen('http://127.0.0.1:18763/__close').close()
