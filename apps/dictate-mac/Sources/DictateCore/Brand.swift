import Foundation

/// The product's name and look, in one place: the suite is being renamed, so nothing else in the
/// app spells the name out. The server has no brand endpoint yet, so these are the values.
/// `scripts/build-app.sh` reads `name` from this file for the bundle's CFBundleName.
public enum Brand {
    public static let name = "Hotsauce"
    /// The accent (the web app's ember), light and dark appearance.
    public static let accentLight: UInt32 = 0xC63D19
    public static let accentDark: UInt32 = 0xFF6A3D
    /// `<scheme>://<path>` opens that path in the app's window.
    public static let urlScheme = "hearth"

    /// The rail's apps, in rail order, for ⌘1…⌘9 (apps/web/src/apps/registry.ts, then Settings).
    public static let railShortcuts: [(title: String, path: String)] = [
        ("Docs", "/docs"),
        ("Meetings", "/meetings"),
        ("Dictate", "/dictate"),
        ("Clips", "/clips"),
        ("Settings", "/settings"),
    ]
}
