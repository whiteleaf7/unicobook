// Gemini でフォルダのアイコンを作っている間に置く「仮」のアイコンを生成する:
// swift scripts/make-placeholder-icon.swift server/placeholder-icon.png
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "server/placeholder-icon.png")
let size = 512
let s = CGFloat(size)
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

NSColor(white: 0.78, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: s, height: s).fill()

let font = NSFont(name: "HiraginoSans-W6", size: s * 0.6) ?? NSFont.boldSystemFont(ofSize: s * 0.6)
let str = NSAttributedString(string: "仮", attributes: [.font: font, .foregroundColor: NSColor.black])
let b = str.size()
str.draw(at: NSPoint(x: (s - b.width) / 2, y: (s - b.height) / 2))

NSGraphicsContext.restoreGraphicsState()
try rep.representation(using: .png, properties: [:])!.write(to: out)
