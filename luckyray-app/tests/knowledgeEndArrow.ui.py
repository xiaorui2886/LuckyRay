"""Down at EOF must not wrap to the beginning, including media boundaries."""
from playwright.sync_api import sync_playwright
from urllib.request import urlopen

with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    try:
        page=browser.new_page(viewport={'width':1000,'height':800})
        page.goto('http://127.0.0.1:18763',wait_until='networkidle')
        page.evaluate('''() => {
            window.eofMoves=0;
            const v=window.view(), original=v.moveVertically.bind(v);
            v.moveVertically=(...args)=>{window.eofMoves++;return original(...args)};
        }''')
        for prefix in ['', 'paragraph\n'*100, '![[a.svg]]\n'*10]:
            for ending in ['', 'text', '\n', '![[a.svg]]', '![[a.svg]]\n', '![[a.svg|300]]text']:
                doc=prefix+ending
                page.evaluate('(v)=>window.reset(v)',doc)
                page.wait_for_timeout(100)
                page.evaluate('(n)=>window.handle.setSelection({start:n,end:n})',len(doc))
                page.wait_for_timeout(100)
                before=page.evaluate('window.view().scrollDOM.scrollTop')
                for _ in range(3):
                    page.keyboard.press('ArrowDown')
                    page.wait_for_timeout(70)
                    actual=page.evaluate('window.handle.getSelection()')
                    assert actual=={'start':len(doc),'end':len(doc)},(len(prefix),ending,actual,len(doc))
                    after=page.evaluate('window.view().scrollDOM.scrollTop')
                    assert abs(after-before)<3,(len(prefix),ending,before,after)
        assert page.evaluate('window.eofMoves')==0, 'EOF must not enter layout-dependent vertical hit testing'
        print('PASS EOF Down: empty/text/blank/media/trailing inline text, short and long notes')
    finally:
        browser.close()
        urlopen('http://127.0.0.1:18763/__close').close()
