"""Production NotesPage browser gate. Start node tests/notes-production-server.mjs.
Uses installed Chromium only; no browser install, native writes, or external files.
"""
from playwright.sync_api import sync_playwright
import os

URL = os.environ.get('NOTES_FIXTURE_URL', 'http://127.0.0.1:1437/tests/fixtures/notes-production.html')
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1600, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL)
    page.wait_for_selector('.notes-document-host:not([hidden]) .cm-editor')
    page.wait_for_function("document.querySelectorAll('.notes-document-host').length === 7")
    page.evaluate("""() => {
      window.originalHosts = new Map([...document.querySelectorAll('[data-notes-view-id]')].map(host => [host.dataset.notesViewId, {host, editor:host.querySelector('.cm-editor')}]));
      const editor=window.editor(); const end=editor.state.doc.length;
      editor.dispatch({changes:{from:end,insert:' retained-draft'},selection:{anchor:end+15},userEvent:'input.type'});
      window.alphaEditor=editor;window.alphaDOM=editor.dom;window.alphaSelection=editor.state.selection.main.head;
      window.openSearch();
    }""")
    page.locator('.notes-document-host:not([hidden]) .cm-search input[name=search]').fill('paragraph')
    # First directional split moves the original full production view, retaining
    # its actual CodeMirror DOM, search UI, selection, undo and document owner.
    tab = page.locator('.fixture-titlebar [data-notes-dock-tab="real-vault:Alpha.md"]').first.bounding_box()
    pane = page.locator('.notes-document-host:not([hidden])').first.bounding_box()
    page.mouse.move(tab['x']+30, tab['y']+15); page.mouse.down()
    page.mouse.move(pane['x']+pane['width']-8, pane['y']+pane['height']/2, steps=12)
    assert page.locator('.notes-dock-drop-overlay').count() == 1
    page.mouse.up()
    page.wait_for_function("document.querySelectorAll('.notes-document-host:not([hidden])').length === 2")
    assert page.evaluate("window.alphaDOM.isConnected && window.alphaEditor.dom === window.alphaDOM")
    assert page.evaluate("window.alphaEditor.state.selection.main.head === window.alphaSelection")
    assert page.locator('.notes-document-host:not([hidden]) .cm-search input[name=search]').input_value() == 'paragraph'
    assert page.evaluate("[...window.originalHosts.values()].every(({host,editor}) => host.isConnected && host.querySelector('.cm-editor')===editor)")
    # Visiting more than four views cannot evict any full view/DOM.
    for title in ['Beta','Gamma','Delta','Epsilon','Zeta','Eta','Beta']:
        page.locator(f'[data-notes-dock-tab="real-vault:{title}.md"]:visible').first.click()
        page.wait_for_timeout(50)
    assert page.evaluate("[...window.originalHosts.values()].every(({host,editor}) => host.isConnected && host.querySelector('.cm-editor')===editor)")
    page.locator('[data-notes-dock-tab="real-vault:Alpha.md"]:visible').first.click()
    assert page.evaluate("window.undoEditor(window.alphaEditor)")
    assert page.evaluate("!window.alphaEditor.state.doc.toString().endsWith(' retained-draft')")
    assert page.evaluate("window.redoEditor(window.alphaEditor)")
    assert page.evaluate("window.alphaEditor.state.doc.toString().endsWith(' retained-draft')")
    page.locator('[data-notes-dock-tab="real-vault:Beta.md"]:visible').first.click()
    # Keyboard access in an inactive visible pane activates its own full controls.
    alpha = page.locator('.notes-document-host[data-notes-view-document="real-vault:Alpha.md"]:visible')
    alpha.locator('.note-attachments-action').focus(); page.keyboard.press('Enter')
    page.wait_for_selector('.lr-attachment-sidebar-frame')
    assert alpha.locator('.note-attachments-action').get_attribute('aria-pressed') == 'true'
    # Escape while held must not activate another tab on the later release.
    before = page.evaluate('window.captureLayouts()')
    beta = page.locator('[data-notes-dock-tab="real-vault:Beta.md"]:visible').first.bounding_box()
    page.mouse.move(beta['x']+20,beta['y']+15);page.mouse.down();page.mouse.move(beta['x']+40,beta['y']+80)
    page.keyboard.press('Escape');page.wait_for_timeout(80);page.mouse.move(beta['x']+20,beta['y']+15);page.mouse.up()
    assert page.evaluate('window.captureLayouts()') == before
    assert page.locator('.notes-dock-drop-overlay').count() == 0
    assert not errors, errors
    page.screenshot(path=os.environ.get('NOTES_SCREENSHOT', '/tmp/notes-production-docking.png'))
    browser.close()
print('PASS production Notes flat-host docking, search/selection retention, seven views, keyboard attachment action, held-Escape cancellation')
