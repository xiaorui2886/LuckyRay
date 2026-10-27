"""Production-component browser regression. Start node tests/graph-session-server.mjs.
Uses synthetic graph seed; never reads a user vault. Browser launch must be allowed.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path('output/graph-retained-sessions')
OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'))
    page = browser.new_page(viewport={'width': 1400, 'height': 900}, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:1441/tests/fixtures/graph-retained-sessions.html')
    page.wait_for_function('window.graphStore?.captureView("graph-1")?.positions.length === 80')
    first = page.locator('[data-graph-session-view="graph-1"]')
    page.evaluate('window.originalGraphCanvas = document.querySelector("[data-graph-session-view=graph-1] canvas")')
    first.get_by_role('button', name='Settings', exact=True).click()
    first.get_by_role('button', name='Show labels', exact=True).click()
    first.get_by_role('textbox', name='Search graph folders or documents').fill('Fixture document 7')
    first.locator('.graph-find-result').first.click()
    page.wait_for_timeout(450)
    before = page.evaluate('window.graphStore.captureView("graph-1")')
    assert before['focusedKey'] == 'fixture-7'
    assert before['view']['showLabels'] is False
    assert before['searchScope']['nodeKeys'] == ['fixture-7']

    # UI titlebar addition creates another actual canvas; selection does not reset.
    page.locator('.graph-tab-new-react').click()
    page.wait_for_function('document.querySelectorAll("[data-graph-session-view] canvas").length === 2')
    second = page.evaluate('window.graphStore.getSnapshot().activeTabId')
    page.wait_for_function('id => window.graphStore.captureView(id)?.positions.length === 80', arg=second)
    assert first.is_hidden()
    hidden_before = page.evaluate('JSON.stringify(window.graphStore.captureView("graph-1"))')
    page.wait_for_timeout(300)
    assert page.evaluate('JSON.stringify(window.graphStore.captureView("graph-1"))') == hidden_before
    page.locator('.titlebar [data-graph-tab-id="graph-1"]').click()
    page.wait_for_timeout(100)
    after = page.evaluate('window.graphStore.captureView("graph-1")')
    for key in ['camera', 'view', 'focusedKey', 'searchScope']:
        assert after[key] == before[key], key
    assert page.evaluate('window.originalGraphCanvas === document.querySelector("[data-graph-session-view=graph-1] canvas")')

    # Duplicate snapshots start equal but edits stay local to the duplicate.
    duplicate = page.evaluate('window.graphStore.add({duplicate: true, sourceTabId: "graph-1"})')
    page.wait_for_function('id => window.graphStore.captureView(id)?.positions.length === 80', arg=duplicate)
    duplicate_view = page.locator(f'[data-graph-session-view="{duplicate}"]')
    assert page.evaluate('id => window.graphStore.captureView(id).focusedKey', duplicate) == 'fixture-7'
    duplicate_view.get_by_role('button', name='Show labels', exact=True).click()
    assert page.evaluate('window.graphStore.captureView("graph-1").view.showLabels') is False
    assert page.evaluate('id => window.graphStore.captureView(id).view.showLabels', duplicate) is True

    # Esc while held must neither move nor activate the original source tab.
    before_cancel = page.evaluate('JSON.stringify(window.graphStore.getSnapshot())')
    source = page.locator('.titlebar [data-graph-tab-id="graph-1"]')
    bounds = source.bounding_box()
    page.mouse.move(bounds['x'] + 12, bounds['y'] + 12)
    page.mouse.down(); page.mouse.move(1385, 450, steps=12)
    assert page.locator('.graph-tab-drop-preview').is_visible()
    page.keyboard.press('Escape'); page.wait_for_timeout(80)
    page.mouse.move(bounds['x'] + 12, bounds['y'] + 12); page.mouse.up()
    assert page.evaluate('JSON.stringify(window.graphStore.getSnapshot())') == before_cancel
    assert page.locator('.graph-tab-drop-preview').count() == 0

    # Real pointer edge split changes group membership without reparenting canvas.
    page.mouse.move(bounds['x'] + 12, bounds['y'] + 12)
    page.mouse.down(); page.mouse.move(1385, 450, steps=12); page.mouse.up()
    page.wait_for_function('window.graphStore.getSnapshot().groups.length === 2')
    assert page.evaluate('window.originalGraphCanvas === document.querySelector("[data-graph-session-view=graph-1] canvas")')
    graph_one = page.evaluate('window.graphStore.captureView("graph-1")')
    assert graph_one['focusedKey'] == 'fixture-7'
    assert graph_one['view']['showLabels'] is False

    # Targeted reset cannot mutate another retained view; route hide/show keeps DOM.
    other_before = page.evaluate('id => window.graphStore.captureView(id).camera', duplicate)
    page.evaluate('window.dispatchEvent(new CustomEvent("luckyray:graph-reset", {detail:{tabId:"graph-1"}}))')
    assert page.evaluate('id => window.graphStore.captureView(id).camera', duplicate) == other_before
    page.evaluate('window.setGraphVisible(false)'); page.wait_for_timeout(100)
    page.evaluate('window.setGraphVisible(true)'); page.wait_for_timeout(150)
    assert page.evaluate('window.originalGraphCanvas === document.querySelector("[data-graph-session-view=graph-1] canvas")')
    page.screenshot(path=str(OUT / 'graph-split-retained.png'))
    assert errors == [], errors
    (OUT / 'results.json').write_text(json.dumps({'passed': ['retained camera/filter/selection/search', 'hidden view stopped', 'duplicate independence', 'held-Escape cancellation', 'real pointer split DOM identity', 'targeted reset isolation', 'route retention'], 'errors': errors}, indent=2))
    browser.close()
