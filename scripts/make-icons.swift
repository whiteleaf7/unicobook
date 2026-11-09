// PWA のアイコンを生成する: swift scripts/make-icons.swift public/icons /path/to/source.png
import AppKit

let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "public/icons")

guard CommandLine.arguments.count > 2 else {
    fatalError("使い方: swift scripts/make-icons.swift <出力フォルダ> <元画像>")
}
let srcPath = URL(fileURLWithPath: CommandLine.arguments[2])

guard let srcData = try? Data(contentsOf: srcPath),
      let srcRep = NSBitmapImageRep(data: srcData),
      let cgImage = srcRep.cgImage else {
    fatalError("元画像が見つかりません: \(srcPath.path)")
}

// 黒いシルエットの検出（ピクセル座標）
var minX = srcRep.pixelsWide, maxX = 0, minY = srcRep.pixelsHigh, maxY = 0
for y in 0..<srcRep.pixelsHigh {
    for x in 0..<srcRep.pixelsWide {
        let c = srcRep.colorAt(x: x, y: y)!
        let brightness = c.redComponent * 0.299 + c.greenComponent * 0.587 + c.blueComponent * 0.114
        if brightness < 0.4 {
            if x < minX { minX = x }
            if x > maxX { maxX = x }
            if y < minY { minY = y }
            if y > maxY { maxY = y }
        }
    }
}

let silW = CGFloat(maxX - minX + 1)
let silH = CGFloat(maxY - minY + 1)
let side = round(max(silW, silH) / 0.88) // 外接矩形 + 6% の余白
let cx = round(CGFloat(minX + maxX) / 2.0)
let cy = round(CGFloat(minY + maxY) / 2.0)

let cropRect = CGRect(x: cx - side / 2.0, y: cy - side / 2.0, width: side, height: side)
guard let cropped = cgImage.cropping(to: cropRect) else {
    fatalError("切り抜きに失敗しました")
}

func render(size: Int) -> Data {
    let s = CGFloat(size)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0)!
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    ctx.imageInterpolation = .high

    let img = NSImage(cgImage: cropped, size: NSSize(width: s, height: s))
    img.draw(in: NSRect(x: 0, y: 0, width: s, height: s))

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
for size in [180, 192, 512] {
    let name = "icon-\(size).png"
    let outUrl = outDir.appendingPathComponent(name)
    try render(size: size).write(to: outUrl)
    print("Generated \(name) (\(size)x\(size))")
}
