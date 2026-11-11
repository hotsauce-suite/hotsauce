import AppKit
import SwiftUI

/// Hearth's tokens (apps/web/src/styles/tokens.css): warm paper by day, charcoal by night, one
/// ember accent. Each colour follows the system appearance.
enum Hearth {
    static let paper = dynamic(light: 0xF2EADF, dark: 0x1D1815)
    static let raised = dynamic(light: 0xFAF5EE, dark: 0x28211D)
    static let sunk = dynamic(light: 0xE8DDCF, dark: 0x161210)
    static let ash = dynamic(light: 0xD6C7B4, dark: 0x3B322C)
    static let ink = dynamic(light: 0x2A221D, dark: 0xEDE3D6)
    static let inkSoft = dynamic(light: 0x5B4E44, dark: 0xC1B2A2)
    static let inkFaint = dynamic(light: 0x8C7C6E, dark: 0x8D7D6F)
    static let ember = dynamic(light: 0xC63D19, dark: 0xFF6A3D)
    static let glow = dynamic(light: 0xEE9A46, dark: 0xFF9D4D)
    static let moss = dynamic(light: 0x4A6A3A, dark: 0xA9C77A)

    static func display(_ size: CGFloat) -> Font { .system(size: size, weight: .semibold, design: .serif) }

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? rgb(dark) : rgb(light)
        })
    }

    private static func rgb(_ hex: UInt32) -> NSColor {
        NSColor(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// App icons by bundle id, cached.
enum AppIcons {
    private static var cache: [String: NSImage] = [:]

    static func icon(for bundle: String?) -> NSImage? {
        guard let bundle else { return nil }
        if let cached = cache[bundle] { return cached }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { return nil }
        let icon = NSWorkspace.shared.icon(forFile: url.path)
        cache[bundle] = icon
        return icon
    }
}
