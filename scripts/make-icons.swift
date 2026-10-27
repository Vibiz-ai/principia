// Principia's icons and the dmg window art, from the temple mark (website/public/favicon.svg: white line art on
// near-black, 24-unit grid). Run: npm run make:icons   (macOS only, no dependencies)
//
//   build/icon.iconset/*.png → build/icon.icns (iconutil, in package.json), build/icon.png (1024)
//   resources/trayTemplate{,@2x}.png   the menu bar template image (black + alpha only, macOS tints it)
//   build/dmg/background{,@2x}.png     the dmg window: arrow + "Drag Principia to Applications" (build/dmg/layout.json)
//
// The app icon follows Apple's macOS grid: an 824/1024 rounded-rect body with continuous ("squircle") corners and a
// 100/1024 margin, so it sits in the Dock at the size of every other app. Stroke weights are tuned per pixel size, and
// below 128 px every horizontal and vertical line is snapped to the pixel grid so the temple stays crisp at 16 px.
// Cool greys only: no warm tones anywhere.
import AppKit
import CoreGraphics
import Foundation

// ---------- canvas ----------

/** A PNG of `w`×`h` pixels drawn in top-left coordinates. */
func png(_ w: Int, _ h: Int, _ draw: (CGContext) -> Void) -> Data {
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.translateBy(x: 0, y: CGFloat(h))
  ctx.scaleBy(x: 1, y: -1)
  ctx.setLineCap(.round)
  ctx.setLineJoin(.round)
  draw(ctx)
  let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
  return rep.representation(using: .png, properties: [:])!
}

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

/** Apple's continuous-corner rounded rect (the iOS/macOS "squircle"), not a plain circular-arc rounded rect. */
func squircle(_ r: CGRect, _ radius: CGFloat) -> CGPath {
  let p = CGMutablePath()
  let c = min(radius, min(r.width, r.height) / 2 / 1.52866483)
  let (x0, y0, x1, y1) = (r.minX, r.minY, r.maxX, r.maxY)
  func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
  p.move(to: pt(x0 + 1.52866483 * c, y0))
  // top-right
  p.addLine(to: pt(x1 - 1.52866483 * c, y0))
  p.addCurve(to: pt(x1 - 0.63149399 * c, y0 + 0.07491100 * c), control1: pt(x1 - 1.08849323 * c, y0), control2: pt(x1 - 0.86840689 * c, y0))
  p.addCurve(to: pt(x1 - 0.07491100 * c, y0 + 0.63149399 * c), control1: pt(x1 - 0.37282392 * c, y0 + 0.16905899 * c), control2: pt(x1 - 0.16905899 * c, y0 + 0.37282392 * c))
  p.addCurve(to: pt(x1, y0 + 1.52866483 * c), control1: pt(x1, y0 + 0.86840689 * c), control2: pt(x1, y0 + 1.08849323 * c))
  // bottom-right
  p.addLine(to: pt(x1, y1 - 1.52866483 * c))
  p.addCurve(to: pt(x1 - 0.07491100 * c, y1 - 0.63149399 * c), control1: pt(x1, y1 - 1.08849323 * c), control2: pt(x1, y1 - 0.86840689 * c))
  p.addCurve(to: pt(x1 - 0.63149399 * c, y1 - 0.07491100 * c), control1: pt(x1 - 0.16905899 * c, y1 - 0.37282392 * c), control2: pt(x1 - 0.37282392 * c, y1 - 0.16905899 * c))
  p.addCurve(to: pt(x1 - 1.52866483 * c, y1), control1: pt(x1 - 0.86840689 * c, y1), control2: pt(x1 - 1.08849323 * c, y1))
  // bottom-left
  p.addLine(to: pt(x0 + 1.52866483 * c, y1))
  p.addCurve(to: pt(x0 + 0.63149399 * c, y1 - 0.07491100 * c), control1: pt(x0 + 1.08849323 * c, y1), control2: pt(x0 + 0.86840689 * c, y1))
  p.addCurve(to: pt(x0 + 0.07491100 * c, y1 - 0.63149399 * c), control1: pt(x0 + 0.37282392 * c, y1 - 0.16905899 * c), control2: pt(x0 + 0.16905899 * c, y1 - 0.37282392 * c))
  p.addCurve(to: pt(x0, y1 - 1.52866483 * c), control1: pt(x0, y1 - 0.86840689 * c), control2: pt(x0, y1 - 1.08849323 * c))
  // top-left
  p.addLine(to: pt(x0, y0 + 1.52866483 * c))
  p.addCurve(to: pt(x0 + 0.07491100 * c, y0 + 0.63149399 * c), control1: pt(x0, y0 + 1.08849323 * c), control2: pt(x0, y0 + 0.86840689 * c))
  p.addCurve(to: pt(x0 + 0.63149399 * c, y0 + 0.07491100 * c), control1: pt(x0 + 0.16905899 * c, y0 + 0.37282392 * c), control2: pt(x0 + 0.37282392 * c, y0 + 0.16905899 * c))
  p.addCurve(to: pt(x0 + 1.52866483 * c, y0), control1: pt(x0 + 0.86840689 * c, y0), control2: pt(x0 + 1.08849323 * c, y0))
  p.closeSubpath()
  return p
}

// ---------- the temple ----------

/**
 * The mark's geometry (favicon.svg: columns M6/10/14/18 from y 11 to 18, base M4 21h16, pediment M12 3l8 5H4z) fitted
 * into `box`, as strokes of width `w`. `snap` puts every horizontal and vertical stroke's edges on whole pixels and
 * mirrors the left half onto the right, so small sizes stay sharp and symmetric. `extra` adds the entablature and
 * the lower step of the stylobate, fainter, for the large sizes.
 */
struct Stroke { var a: CGPoint; var b: CGPoint; var alpha: CGFloat; var weight: CGFloat = 1 }

func temple(in box: CGRect, w: CGFloat, snap: Bool, extra: Bool, columns: [CGFloat] = [6, 10, 14, 18]) -> (lines: [Stroke], roof: [CGPoint]) {
  // the mark spans x 4…20, y 3…21 of its 24 grid: 16 × 18 units
  let u = min(box.width / 16, box.height / 18)
  let ox = box.midX - 12 * u, oy = box.midY - 12 * u
  let cx = box.midX
  func s(_ v: CGFloat) -> CGFloat {
    // centre of a w-wide stroke whose edges fall on whole pixels
    guard snap else { return v }
    let half = w.truncatingRemainder(dividingBy: 2) == 1 ? 0.5 : 0
    return (v - half).rounded() + half
  }
  func X(_ gx: CGFloat) -> CGFloat {
    let v = ox + gx * u
    if !snap { return v }
    // snap the left half; the right half is its mirror image
    if v <= cx { return s(v) }
    return 2 * cx - s(2 * cx - v)
  }
  func Y(_ gy: CGFloat) -> CGFloat { s(oy + gy * u) }
  var lines: [Stroke] = []
  let colTop = Y(11), colBottom = Y(18)
  for gx in columns { lines.append(Stroke(a: CGPoint(x: X(gx), y: colTop), b: CGPoint(x: X(gx), y: colBottom), alpha: 1)) }
  lines.append(Stroke(a: CGPoint(x: X(4), y: Y(21)), b: CGPoint(x: X(20), y: Y(21)), alpha: 1))
  if extra {
    // the upper step of the stylobate, fainter and finer, as the arch's secondary lines are (phone icon.svg)
    lines.append(Stroke(a: CGPoint(x: X(5.5), y: Y(19.5)), b: CGPoint(x: X(18.5), y: Y(19.5)), alpha: 0.38, weight: 0.6))
  }
  let roof = [CGPoint(x: cx, y: oy + 3 * u), CGPoint(x: X(20), y: Y(8)), CGPoint(x: X(4), y: Y(8))]
  return (lines, roof)
}

func strokeTemple(_ ctx: CGContext, _ t: (lines: [Stroke], roof: [CGPoint]), w: CGFloat, color: UInt32, cap: CGLineCap = .round) {
  ctx.setLineWidth(w)
  ctx.setLineCap(cap)
  ctx.setLineJoin(.round)
  for l in t.lines {
    ctx.setLineWidth(w * l.weight)
    ctx.setStrokeColor(rgb(color, l.alpha))
    ctx.move(to: l.a)
    ctx.addLine(to: l.b)
    ctx.strokePath()
  }
  ctx.setLineWidth(w)
  ctx.setStrokeColor(rgb(color))
  ctx.addLines(between: t.roof)
  ctx.closePath()
  ctx.strokePath()
}

// ---------- the app icon ----------

/** Per pixel size: body inset, stroke width, temple size (fraction of the body), whether to snap and add detail. */
func iconSpec(_ s: Int) -> (inset: CGFloat, w: CGFloat, fill: CGFloat, snap: Bool, extra: Bool) {
  switch s {
  case ...16: return (1, 1, 0.70, true, false)
  case ...32: return (3, 2, 0.62, true, false)
  case ...64: return (6, 3, 0.58, true, false)
  case ...128: return (12, 4, 0.56, true, true)
  case ...256: return (25, CGFloat(s) * 0.025, 0.58, false, true)
  default: return (CGFloat(s) * 100 / 1024, CGFloat(s) * 0.021, 0.58, false, true)
  }
}

func appIcon(_ ctx: CGContext, _ px: Int) {
  let s = CGFloat(px)
  let k = s / 1024
  let spec = iconSpec(px)
  let body = CGRect(x: spec.inset, y: spec.inset, width: s - 2 * spec.inset, height: s - 2 * spec.inset)
  let shape = squircle(body, body.width * 185.4 / 824)

  // Apple's grid shadow: straight down, soft
  if px >= 32 {
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10 * k), blur: 20 * k, color: rgb(0x000000, 0.42))
    ctx.addPath(shape)
    ctx.setFillColor(rgb(0x15191b))
    ctx.fillPath()
    ctx.restoreGState()
  }

  // body: cool graphite, lighter at the top
  ctx.saveGState()
  ctx.addPath(shape)
  ctx.clip()
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  let g = CGGradient(colorsSpace: cs, colors: [rgb(0x363d42), rgb(0x1c2124), rgb(0x0e1113)] as CFArray, locations: [0, 0.55, 1])!
  ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: body.minY), end: CGPoint(x: 0, y: body.maxY), options: [])
  // a soft cool light from above
  let glow = CGGradient(colorsSpace: cs, colors: [rgb(0xdfe8ec, 0.10), rgb(0xdfe8ec, 0)] as CFArray, locations: [0, 1])!
  ctx.drawRadialGradient(glow, startCenter: CGPoint(x: s / 2, y: body.minY), startRadius: 0,
                         endCenter: CGPoint(x: s / 2, y: body.minY), endRadius: body.width * 0.75, options: [])
  // light falling on the temple from above, pooling on the ground in front of it
  let pool = CGGradient(colorsSpace: cs, colors: [rgb(0xc9d6dc, 0.12), rgb(0xc9d6dc, 0)] as CFArray, locations: [0, 1])!
  ctx.drawRadialGradient(pool, startCenter: CGPoint(x: s / 2, y: s * 0.5), startRadius: 0,
                         endCenter: CGPoint(x: s / 2, y: s * 0.5), endRadius: body.width * 0.42, options: [])
  ctx.restoreGState()

  // rim: a hairline catching the light at the top, darker at the bottom
  if px >= 32 {
    ctx.saveGState()
    ctx.addPath(shape)
    ctx.clip()
    ctx.addPath(shape)
    ctx.setLineWidth(max(1, 3 * k) * 2)
    ctx.replacePathWithStrokedPath()
    ctx.clip()
    let rim = CGGradient(colorsSpace: cs, colors: [rgb(0xffffff, 0.22), rgb(0xffffff, 0.04), rgb(0x000000, 0.25)] as CFArray, locations: [0, 0.45, 1])!
    ctx.drawLinearGradient(rim, start: CGPoint(x: 0, y: body.minY), end: CGPoint(x: 0, y: body.maxY), options: [])
    ctx.restoreGState()
  }

  // the temple, engraved: a faint shadow under crisp white line art
  let side = body.width * spec.fill
  let box = CGRect(x: s / 2 - side / 2, y: s / 2 - side / 2 + body.width * 0.005, width: side, height: side)
  let t = temple(in: box, w: spec.w, snap: spec.snap, extra: spec.extra)
  if px >= 64 {
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -6 * k), blur: 14 * k, color: rgb(0x000000, 0.55))
    strokeTemple(ctx, t, w: spec.w, color: 0xedf1f2, cap: spec.snap ? .square : .round)
    ctx.restoreGState()
  } else {
    strokeTemple(ctx, t, w: spec.w, color: 0xedf1f2, cap: .square)
  }
}

// ---------- the menu bar template ----------

func trayIcon(_ ctx: CGContext, _ px: Int) {
  // 18 pt: the temple fills the square, black + alpha only (macOS tints a template image)
  let s = CGFloat(px)
  let w: CGFloat = px <= 18 ? 1 : 2
  let t = temple(in: CGRect(x: 0, y: 0, width: s, height: s).insetBy(dx: s * 0.06, dy: s * 0.08), w: w, snap: true, extra: false)
  strokeTemple(ctx, t, w: w, color: 0x000000, cap: .square)
}

// ---------- the dmg window ----------

struct Layout: Decodable {
  struct Pos: Decodable { let x: Double; let y: Double }
  let window: [String: Double]
  let iconSize: Double
  let icons: [String: Pos]
  let text: String
  let labelPlate: [String: Double]
}

func dmgBackground(_ ctx: CGContext, _ L: Layout, scale: CGFloat) {
  let w = CGFloat(L.window["width"]!), h = CGFloat(L.window["height"]!)
  ctx.scaleBy(x: scale, y: scale)
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  // near-black, a touch lighter in the middle
  ctx.setFillColor(rgb(0x0f1213))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  let glow = CGGradient(colorsSpace: cs, colors: [rgb(0x2a3034, 0.55), rgb(0x0f1213, 0)] as CFArray, locations: [0, 1])!
  ctx.drawRadialGradient(glow, startCenter: CGPoint(x: w / 2, y: h * 0.42), startRadius: 0,
                         endCenter: CGPoint(x: w / 2, y: h * 0.42), endRadius: w * 0.62, options: [])

  // the arrow, between the two icons (icon positions are their centres)
  let app = L.icons["Principia.app"]!, apps = L.icons["Applications"]!
  let half = CGFloat(L.iconSize) / 2
  let y = CGFloat(app.y)
  let x0 = CGFloat(app.x) + half + 34, x1 = CGFloat(apps.x) - half - 34
  ctx.setStrokeColor(rgb(0xedf1f2, 0.9))
  ctx.setLineWidth(2)
  ctx.setLineCap(.round)
  ctx.setLineJoin(.round)
  ctx.move(to: CGPoint(x: x0, y: y))
  ctx.addLine(to: CGPoint(x: x1, y: y))
  ctx.move(to: CGPoint(x: x1 - 13, y: y - 13))
  ctx.addLine(to: CGPoint(x: x1, y: y))
  ctx.addLine(to: CGPoint(x: x1 - 13, y: y + 13))
  ctx.strokePath()
  // a faint dotted lead-in, like an engraver's guide line
  ctx.setStrokeColor(rgb(0xedf1f2, 0.35))
  ctx.setLineWidth(2)
  ctx.setLineDash(phase: 0, lengths: [0.01, 7])
  ctx.move(to: CGPoint(x: x0 - 22, y: y))
  ctx.addLine(to: CGPoint(x: x0 - 6, y: y))
  ctx.strokePath()
  ctx.setLineDash(phase: 0, lengths: [])

  // Finder draws icon labels in black over a picture background, in dark mode too: each label sits on a light
  // plate, like the name cut into a marble plaque, so it can be read
  let pw = CGFloat(L.labelPlate["width"]!), ph = CGFloat(L.labelPlate["height"]!), dy = CGFloat(L.labelPlate["dy"]!)
  for p in L.icons.values {
    let r = CGRect(x: CGFloat(p.x) - pw / 2, y: CGFloat(p.y) + dy - ph / 2, width: pw, height: ph)
    ctx.addPath(CGPath(roundedRect: r, cornerWidth: ph / 2, cornerHeight: ph / 2, transform: nil))
    ctx.setFillColor(rgb(0xd3dadd, 0.92))
    ctx.fillPath()
  }

  // the instruction
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
  let para = NSMutableParagraphStyle()
  para.alignment = .center
  let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 15, weight: .regular),
    .foregroundColor: NSColor(srgbRed: 0xed / 255, green: 0xf1 / 255, blue: 0xf2 / 255, alpha: 0.86),
    .kern: 0.3,
    .paragraphStyle: para
  ]
  let str = NSAttributedString(string: L.text, attributes: attrs)
  let th = str.size().height
  str.draw(in: CGRect(x: 0, y: CGFloat(L.window["textY"]!) - th / 2, width: w, height: th + 2))
  NSGraphicsContext.restoreGraphicsState()
}

// ---------- write everything ----------

let fm = FileManager.default
func write(_ data: Data, _ file: String) {
  try! fm.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
  try! data.write(to: URL(fileURLWithPath: file))
}

let args = CommandLine.arguments
let outRoot = args.count > 1 ? args[1] : "."
let iconset = "\(outRoot)/build/icon.iconset"
try? fm.removeItem(atPath: iconset)
for base in [16, 32, 128, 256, 512] {
  write(png(base, base) { appIcon($0, base) }, "\(iconset)/icon_\(base)x\(base).png")
  write(png(base * 2, base * 2) { appIcon($0, base * 2) }, "\(iconset)/icon_\(base)x\(base)@2x.png")
}
write(png(1024, 1024) { appIcon($0, 1024) }, "\(outRoot)/build/icon.png")
write(png(18, 18) { trayIcon($0, 18) }, "\(outRoot)/resources/trayTemplate.png")
write(png(36, 36) { trayIcon($0, 36) }, "\(outRoot)/resources/trayTemplate@2x.png")

let layout = try! JSONDecoder().decode(Layout.self, from: Data(contentsOf: URL(fileURLWithPath: "\(outRoot)/build/dmg/layout.json")))
let (bw, bh) = (Int(layout.window["width"]!), Int(layout.window["height"]!))
write(png(bw, bh) { dmgBackground($0, layout, scale: 1) }, "\(outRoot)/build/dmg/background.png")
write(png(bw * 2, bh * 2) { dmgBackground($0, layout, scale: 2) }, "\(outRoot)/build/dmg/background@2x.png")
