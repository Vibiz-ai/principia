// Generates build/icon.icns (app icon) and resources/trayTemplate{,@2x}.png (menu bar template icon).
// Run: swift scripts/make-icons.swift   (macOS only, no deps)
import AppKit

func hexPath(center: CGPoint, radius: CGFloat) -> NSBezierPath {
  let p = NSBezierPath()
  for i in 0..<6 {
    let a = CGFloat(i) * .pi / 3 + .pi / 6
    let pt = CGPoint(x: center.x + radius * cos(a), y: center.y + radius * sin(a))
    if i == 0 { p.move(to: pt) } else { p.line(to: pt) }
  }
  p.close()
  return p
}

func png(size: Int, draw: (CGFloat) -> Void) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                             bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  draw(CGFloat(size))
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

func appIcon(_ s: CGFloat) {
  let inset = s * 0.1
  let bg = NSBezierPath(roundedRect: NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset),
                        xRadius: s * 0.18, yRadius: s * 0.18)
  NSGradient(starting: NSColor(calibratedRed: 0.10, green: 0.10, blue: 0.12, alpha: 1),
             ending: NSColor(calibratedRed: 0.05, green: 0.05, blue: 0.06, alpha: 1))!.draw(in: bg, angle: -90)
  let amber = NSColor(calibratedRed: 1.0, green: 0.72, blue: 0.18, alpha: 1)
  let c = CGPoint(x: s / 2, y: s / 2)
  let r = s * 0.11
  let dx = r * sqrt(3) + s * 0.012
  let centers = [CGPoint(x: c.x, y: c.y), CGPoint(x: c.x - dx, y: c.y), CGPoint(x: c.x + dx, y: c.y),
                 CGPoint(x: c.x - dx / 2, y: c.y + r * 1.55 + s * 0.01), CGPoint(x: c.x + dx / 2, y: c.y + r * 1.55 + s * 0.01),
                 CGPoint(x: c.x - dx / 2, y: c.y - r * 1.55 - s * 0.01), CGPoint(x: c.x + dx / 2, y: c.y - r * 1.55 - s * 0.01)]
  for (i, pt) in centers.enumerated() {
    (i == 0 ? amber : amber.withAlphaComponent(0.55)).setFill()
    hexPath(center: pt, radius: r).fill()
  }
}

func trayIcon(_ s: CGFloat) {
  NSColor.black.setFill()
  let r = s * 0.2
  let dx = r * sqrt(3) + s * 0.04
  let c = CGPoint(x: s / 2, y: s / 2)
  for pt in [CGPoint(x: c.x - dx / 2, y: c.y + r * 0.8), CGPoint(x: c.x + dx / 2, y: c.y + r * 0.8), CGPoint(x: c.x, y: c.y - r * 0.85)] {
    hexPath(center: pt, radius: r).fill()
  }
}

let fm = FileManager.default
let iconset = "build/icon.iconset"
try? fm.removeItem(atPath: iconset)
try! fm.createDirectory(atPath: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
  try! png(size: base, draw: appIcon).write(to: URL(fileURLWithPath: "\(iconset)/icon_\(base)x\(base).png"))
  try! png(size: base * 2, draw: appIcon).write(to: URL(fileURLWithPath: "\(iconset)/icon_\(base)x\(base)@2x.png"))
}
try! png(size: 1024, draw: appIcon).write(to: URL(fileURLWithPath: "build/icon.png"))
try! fm.createDirectory(atPath: "resources", withIntermediateDirectories: true)
try! png(size: 18, draw: trayIcon).write(to: URL(fileURLWithPath: "resources/trayTemplate.png"))
try! png(size: 36, draw: trayIcon).write(to: URL(fileURLWithPath: "resources/trayTemplate@2x.png"))
