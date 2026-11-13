import AppKit
import DictateCore

// `HearthDictate --transcribe-file <path> [--literal]` runs one upload and prints the result,
// for automated end-to-end tests. Anything else starts the app.
if let index = CommandLine.arguments.firstIndex(of: "--render-previews"), index + 1 < CommandLine.arguments.count {
    let folder = CommandLine.arguments[index + 1]
    let dark = CommandLine.arguments.contains("--dark")
    exit(MainActor.assumeIsolated { Previews.render(to: folder, dark: dark) })
}
if let index = CommandLine.arguments.firstIndex(of: "--render-app-icon"), index + 1 < CommandLine.arguments.count {
    exit(MainActor.assumeIsolated { ProductMark.renderIconset(to: CommandLine.arguments[index + 1]) })
}
if CommandLine.arguments.contains("--self-test") {
    exit(MainActor.assumeIsolated { SelfTest.run(arguments: CommandLine.arguments) })
}
if CommandLine.arguments.contains("--meeting-audio-probe") {
    exit(MainActor.assumeIsolated { MeetingProbe.run(arguments: CommandLine.arguments) })
}
if CommandLine.arguments.contains("--call-probe") {
    // Prints, every 2 s for the given seconds, which other app is using the mic (call detection).
    let args = CommandLine.arguments
    let seconds = args.firstIndex(of: "--call-probe").flatMap { args.indices.contains($0 + 1) ? Double(args[$0 + 1]) : nil } ?? 10
    if #available(macOS 14.2, *) {
        var left = seconds
        while left > 0 {
            MainActor.assumeIsolated {
                let users = CallDetector.micUsers().map { user in
                    let candidate = MicApps.isCallCandidate(user.bundleID, ownBundleID: Bundle.main.bundleIdentifier)
                    return "\(user.pid):\(user.bundleID ?? "?"):\(candidate ? "candidate" : "ignored"):\(CallDetector.appName(of: user) ?? "no app")"
                }
                print("\(CallDetector.callAppUsingMic() ?? "-")  [\(users.joined(separator: ", "))]")
            }
            fflush(stdout)
            Thread.sleep(forTimeInterval: 2)
            left -= 2
        }
        exit(0)
    }
    print("needs macOS 14.2")
    exit(1)
}
if CommandLine.arguments.contains("--transcribe-file") {
    exit(CLI.run(arguments: Array(CommandLine.arguments.dropFirst())))
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
}
