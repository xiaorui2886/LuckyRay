// Observe only the freshly launched LuckyRay process. This does not invoke
// Accessibility, Apple Events, or request a privacy authorization.
import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]), pid > 0 else { exit(64) }
guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { exit(3) }
for window in windows {
    guard let owner = window[kCGWindowOwnerPID as String] as? NSNumber, owner.int32Value == pid,
          let id = window[kCGWindowNumber as String] as? NSNumber,
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let width = bounds["Width"] as? NSNumber, let height = bounds["Height"] as? NSNumber,
          width.doubleValue >= 1000, height.doubleValue >= 600,
          let layer = window[kCGWindowLayer as String] as? NSNumber, layer.intValue == 0 else { continue }
    let record: [String: Any] = ["pid": pid, "windowID": id.uint32Value, "width": width.doubleValue, "height": height.doubleValue]
    let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    exit(0)
}
exit(2)
