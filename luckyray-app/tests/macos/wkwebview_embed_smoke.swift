// Synthetic native substrate check only. It is not LuckyRay, does not qualify
// its browser security policy, and must never be bundled into the application.
import AppKit
import Foundation
import WebKit

final class Smoke: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow?
    private var root: NSView?
    private var webview: WKWebView?
    private var finished = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let path = ProcessInfo.processInfo.environment["LUCKYRAY_MACOS_SMOKE_PNG"],
              path.hasPrefix("/"), !FileManager.default.fileExists(atPath: path) else {
            finish(false, "output-path-invalid")
            return
        }

        NSApplication.shared.setActivationPolicy(.regular)
        let window = NSWindow(
            contentRect: NSRect(x: 120, y: 120, width: 600, height: 420),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "LuckyRay synthetic WKWebView smoke"
        window.isReleasedWhenClosed = false
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 420))
        window.contentView = root
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        let webview = WKWebView(frame: NSRect(x: 20, y: 20, width: 320, height: 240), configuration: config)
        webview.navigationDelegate = self
        webview.isHidden = true
        root.addSubview(webview)
        self.window = window
        self.root = root
        self.webview = webview
        guard webview.superview === root, webview.isHidden, !config.websiteDataStore.isPersistent else {
            finish(false, "initial-embedding-invalid")
            return
        }
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        webview.loadHTMLString("""
          <!doctype html><html><head><meta charset="utf-8"><title>Synthetic WKWebView</title>
          <style>body{margin:0;padding:24px;background:#132130;color:#fff;font:20px sans-serif}</style></head>
          <body data-fixture="luckyray-native-smoke">Synthetic WKWebView child<br>素材 ①</body></html>
          """, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            self?.finish(false, "native-webview-timeout")
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(url == nil || url?.absoluteString == "about:blank" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(false, "navigation-failed")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(false, "navigation-failed")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let root = root, let window = window, webView === webview,
              webView.superview === root, webView.window === window else {
            finish(false, "parent-window-mismatch")
            return
        }
        let expected = NSRect(x: 36, y: 48, width: 420, height: 280)
        webView.frame = expected
        webView.isHidden = false
        guard webView.frame == expected, !webView.isHidden else {
            finish(false, "native-layout-mismatch")
            return
        }
        webView.evaluateJavaScript("document.body.dataset.fixture") { [weak self] value, error in
            guard let self = self, error == nil, value as? String == "luckyray-native-smoke" else {
                self?.finish(false, "synthetic-document-invalid")
                return
            }
            self.sendCommandKey(to: webView, in: window)
        }
    }

    private func sendCommandKey(to webView: WKWebView, in window: NSWindow) {
        let listener = """
          window.__lrSyntheticKey = false;
          document.addEventListener('keydown', e => {
            if (e.metaKey && e.key.toLowerCase() === 's') { e.preventDefault(); window.__lrSyntheticKey = true; }
          }); true;
          """
        webView.evaluateJavaScript(listener) { [weak self] _, error in
            guard let self = self, error == nil, window.makeFirstResponder(webView),
                  let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command],
                                               timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: window.windowNumber, context: nil,
                                               characters: "s", charactersIgnoringModifiers: "s",
                                               isARepeat: false, keyCode: 1) else {
                self?.finish(false, "native-key-dispatch-unavailable")
                return
            }
            window.sendEvent(event)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                webView.evaluateJavaScript("window.__lrSyntheticKey === true") { [weak self] value, error in
                    guard let self = self, error == nil, value as? Bool == true else {
                        self?.finish(false, "native-command-key-not-observed")
                        return
                    }
                    self.capture(webView)
                }
            }
        }
    }

    private func capture(_ webView: WKWebView) {
        webView.takeSnapshot(with: nil) { [weak self] image, error in
                guard let self = self, error == nil, let image = image,
                      image.size.width > 0, image.size.height > 0,
                      let tiff = image.tiffRepresentation,
                      let bitmap = NSBitmapImageRep(data: tiff),
                      let png = bitmap.representation(using: .png, properties: [:]),
                      let path = ProcessInfo.processInfo.environment["LUCKYRAY_MACOS_SMOKE_PNG"] else {
                    self?.finish(false, "snapshot-failed")
                    return
                }
                do {
                    try png.write(to: URL(fileURLWithPath: path), options: .withoutOverwriting)
                    self.finish(true, "native-child-layout-command-key-snapshot")
                } catch {
                    self.finish(false, "snapshot-write-failed")
                }
        }
    }

    private func finish(_ ok: Bool, _ code: String) {
        guard !finished else { return }
        finished = true
        let record: [String: Any] = ["result": ok ? "PASS" : "FAIL", "check": code,
                                     "scope": "synthetic-wkwebview-substrate-only"]
        if let bytes = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]),
           let line = String(data: bytes, encoding: .utf8) {
            print(line)
            fflush(stdout)
        }
        window?.close()
        exit(ok ? 0 : 1)
    }
}

let app = NSApplication.shared
let smoke = Smoke()
app.delegate = smoke
app.run()
