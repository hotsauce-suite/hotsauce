import AppKit

// `HearthDictate --transcribe-file <path> [--literal]` runs one upload and prints the result,
// for automated end-to-end tests. Anything else starts the app.
if let index = CommandLine.arguments.firstIndex(of: "--render-previews"), index + 1 < CommandLine.arguments.count {
    let folder = CommandLine.arguments[index + 1]
    let dark = CommandLine.arguments.contains("--dark")
    exit(MainActor.assumeIsolated { Previews.render(to: folder, dark: dark) })
}
if CommandLine.arguments.contains("--self-test") {
    exit(MainActor.assumeIsolated { SelfTest.run(arguments: CommandLine.arguments) })
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
