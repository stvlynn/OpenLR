import AppKit
import Darwin
import Foundation

@MainActor
private final class LaunchState {
    var application: NSRunningApplication?
    var launchError: Error?
    var launchCompleted = false
    var stopRequested = false
}

@main
private enum LaunchAndOwn {
    @MainActor
    static func main() {
        _ = signal(SIGPIPE, SIG_IGN)
        exit(run())
    }

    @MainActor
    private static func run() -> Int32 {
        let args = CommandLine.arguments
        guard args.count == 3 else {
            return fail("Pass the packaged OpenLR executable and the document path")
        }
        let executable = canonical(URL(fileURLWithPath: args[1]))
        let bundleURL = executable.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        let document = canonical(URL(fileURLWithPath: args[2]))
        guard bundleURL.pathExtension == "app",
              let bundle = Bundle(url: bundleURL),
              canonical(bundle.executableURL)?.path == executable.path,
              FileManager.default.fileExists(atPath: document.path) else {
            return fail("Expected an app bundle executable and an existing document")
        }

        let environment = ProcessInfo.processInfo.environment.filter {
            $0.key.hasPrefix("OPENLR_") || $0.key.hasPrefix("XDG_")
        }
        guard let session = environment["OPENLR_AGENT_FILE"], session.hasPrefix("/"),
              let runtime = environment["XDG_RUNTIME_DIR"], runtime.hasPrefix("/"),
              canonical(URL(fileURLWithPath: session).deletingLastPathComponent()).path
                  == canonical(URL(fileURLWithPath: runtime)).path,
              environment["OPENLR_EPHEMERAL"] == "1",
              !FileManager.default.fileExists(atPath: session) else {
            return fail("Expected a fresh agent descriptor in the private ephemeral runtime directory")
        }

        let workspace = NSWorkspace.shared
        guard !workspace.runningApplications.contains(where: {
            canonical($0.bundleURL)?.path == bundleURL.path
        }) else {
            return fail("The specified bundle already has a running instance")
        }

        let state = LaunchState()
        DispatchQueue.global().async {
            let input = FileHandle.standardInput
            while let data = try? input.read(upToCount: 256), !data.isEmpty {}
            DispatchQueue.main.async { state.stopRequested = true }
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.environment = environment
        configuration.createsNewApplicationInstance = true
        configuration.allowsRunningApplicationSubstitution = false
        configuration.addsToRecentItems = false
        configuration.promptsUserIfNeeded = false
        workspace.open([document], withApplicationAt: bundleURL, configuration: configuration) { app, error in
            DispatchQueue.main.async {
                state.application = app
                state.launchError = error
                state.launchCompleted = true
            }
        }

        guard wait(35, until: { state.launchCompleted }) else {
            return fail("Launch Services did not confirm the launch within 35 seconds", unconfirmed: true)
        }
        guard let app = state.application else {
            let reason = state.launchError.map { ": \($0.localizedDescription)" } ?? ""
            return fail("Launch Services did not return an application\(reason)", unconfirmed: true)
        }
        guard !app.isTerminated else { return fail("The launched app exited before reporting its PID") }
        guard app.processIdentifier > 0,
              canonical(app.bundleURL)?.path == bundleURL.path,
              canonical(app.executableURL)?.path == executable.path else {
            return fail("Launch Services returned a different application", unconfirmed: true)
        }

        do {
            try FileHandle.standardOutput.write(contentsOf: Data("\(app.processIdentifier)\n".utf8))
        } catch {
            guard terminate(app) else { return fail("App shutdown was unconfirmed", unconfirmed: true) }
            return fail("Could not report the launched app PID")
        }
        while !state.stopRequested && !app.isTerminated { runMainLoop() }
        guard !app.isTerminated else { return fail("The launched app exited before shutdown was requested") }
        return terminate(app) ? 0 : fail("App shutdown was unconfirmed", unconfirmed: true)
    }

    @MainActor
    private static func terminate(_ app: NSRunningApplication) -> Bool {
        _ = app.terminate()
        if wait(3, until: { app.isTerminated }) { return true }
        _ = app.forceTerminate()
        return wait(3, until: { app.isTerminated })
    }

    private static func canonical(_ url: URL) -> URL {
        url.standardizedFileURL.resolvingSymlinksInPath()
    }

    private static func canonical(_ url: URL?) -> URL? {
        url.map { canonical($0) }
    }

    @MainActor
    private static func runMainLoop() {
        let until = Date(timeIntervalSinceNow: 0.05)
        if !RunLoop.main.run(mode: .default, before: until) {
            Thread.sleep(until: until)
        }
    }

    @MainActor
    private static func wait(_ seconds: TimeInterval, until condition: () -> Bool) -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + seconds
        while !condition() && ProcessInfo.processInfo.systemUptime < deadline { runMainLoop() }
        return condition()
    }

    private static func fail(_ message: String, unconfirmed: Bool = false) -> Int32 {
        try? FileHandle.standardError.write(contentsOf: Data("Cold document launch: \(message)\n".utf8))
        return unconfirmed ? 2 : 1
    }
}
