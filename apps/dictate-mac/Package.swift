// swift-tools-version:5.10
import PackageDescription

// Hearth Dictate for Mac. `swift build` and `swift test` need only the Command Line Tools;
// scripts/build-app.sh assembles, signs and zips HearthDictate.app.
let package = Package(
    name: "HearthDictate",
    platforms: [.macOS(.v14)],
    targets: [
        // Everything that can be tested without a microphone, a keyboard or a server.
        .target(name: "DictateCore"),
        .executableTarget(name: "HearthDictate", dependencies: ["DictateCore"]),
        .testTarget(name: "DictateCoreTests", dependencies: ["DictateCore"]),
    ]
)
