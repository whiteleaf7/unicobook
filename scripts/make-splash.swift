// iOS PWA のスプラッシュ画像を生成する: swift scripts/make-splash.swift
import AppKit

let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "public/splash")
let iconFile = URL(fileURLWithPath: "public/icons/icon-512.png")
guard let iconData = try? Data(contentsOf: iconFile), let iconImage = NSImage(data: iconData) else {
    fatalError("アイコンが見つかりません: \(iconFile.path)")
}

struct Screen {
    let ptWidth: Int
    let ptHeight: Int
    let scale: Int
    var pxWidth: Int { ptWidth * scale }
    var pxHeight: Int { ptHeight * scale }
}

// iPhone 15 Pro 用スプラッシュ画像
let screens: [Screen] = [
    Screen(ptWidth: 393, ptHeight: 852, scale: 3),
]

func renderSplash(width: Int, height: Int, isDark: Bool) -> Data {
    let w = CGFloat(width)
    let h = CGFloat(height)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high

    // 背景色（アプリのテーマカラーと完全一致）
    let bgColor = isDark
        ? NSColor(red: 0x12 / 255.0, green: 0x12 / 255.0, blue: 0x12 / 255.0, alpha: 1)
        : NSColor(red: 0xfb / 255.0, green: 0xfa / 255.0, blue: 0xf6 / 255.0, alpha: 1)
    bgColor.setFill()
    NSRect(x: 0, y: 0, width: w, height: h).fill()

    // 中央のアイコンサイズ（画面幅の約 24%）
    let iconSize = round(min(w, h) * 0.24)
    let iconRect = NSRect(
        x: round((w - iconSize) / 2),
        y: round((h - iconSize) / 2),
        width: iconSize,
        height: iconSize
    )

    // アイコン背景の角丸四角形
    let cornerRadius = iconSize * 0.2237 // iOS アプリアイコン標準の曲率
    let clipPath = NSBezierPath(roundedRect: iconRect, xRadius: cornerRadius, yRadius: cornerRadius)

    NSGraphicsContext.saveGraphicsState()
    clipPath.addClip()

    // PWA アイコン（ユニコーン）を描画
    iconImage.draw(in: iconRect, from: .zero, operation: .copy, fraction: 1.0)

    NSGraphicsContext.restoreGraphicsState()

    // アイコンの薄い枠線
    let strokeColor = isDark
        ? NSColor(white: 1.0, alpha: 0.12)
        : NSColor(white: 0.0, alpha: 0.08)
    strokeColor.setStroke()
    clipPath.lineWidth = max(1, w * 0.0015)
    clipPath.stroke()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

for screen in screens {
    let key = "\(screen.pxWidth)x\(screen.pxHeight)"
    let lightData = renderSplash(width: screen.pxWidth, height: screen.pxHeight, isDark: false)
    try lightData.write(to: outDir.appendingPathComponent("splash-\(key).png"))

    let darkData = renderSplash(width: screen.pxWidth, height: screen.pxHeight, isDark: true)
    try darkData.write(to: outDir.appendingPathComponent("splash-dark-\(key).png"))
    print("Generated splash: \(key)")
}
