import Foundation

/*
 Two small pure pieces of the Mac app's agent turn, kept here so they are unit
 tested without spawning the CLI.

 ThinkingFallback (2026-11-16): the gateway rejects a thinking level the
 configured model cannot honour ("Thinking level \"low\" is not supported for
 ..."). ThinkingPolicy already sends "off" for an unnamed model; this is the
 backstop so a later config change cannot turn multi-part messages into errors.

 TurnMarks: the part of a turn no plugin can see. Three durations, numbers only
 (never message text): send to process spawn, spawn to first output byte, spawn
 to exit.
*/
public enum ThinkingFallback {
    /// The gateway's pre-flight rejection reads `Thinking level "<x>" is not
    /// supported for <model>`. Both parts, in that order: a bare "is not
    /// supported for" also appears in unrelated errors, and retrying those with
    /// thinking off would hide the real failure.
    public static let levelPrefix = "Thinking level \""
    public static let marker = "is not supported for"

    public static func isThinkingRejection(_ stderr: String) -> Bool {
        guard let prefix = stderr.range(of: levelPrefix) else { return false }
        return stderr.range(of: marker, range: prefix.upperBound..<stderr.endIndex) != nil
    }

    /// The level to retry with, or nil when the failure is not the thinking
    /// rejection (or "off" was already what failed, so retrying cannot help).
    public static func retryLevel(stderr: String, usedLevel: String) -> String? {
        guard usedLevel != "off", isThinkingRejection(stderr) else { return nil }
        return "off"
    }
}

public struct TurnMarks: Equatable, Sendable {
    public let clickToSpawnMs: Int
    public let spawnToFirstByteMs: Int?
    public let spawnToExitMs: Int

    public init(sent: Date, spawned: Date, firstByte: Date?, exited: Date) {
        func ms(_ from: Date, _ to: Date) -> Int { max(0, Int((to.timeIntervalSince(from) * 1000).rounded())) }
        clickToSpawnMs = ms(sent, spawned)
        spawnToFirstByteMs = firstByte.map { ms(spawned, $0) }
        spawnToExitMs = ms(spawned, exited)
    }

    /// One log line, numbers and the session key only.
    public func logLine(session: String) -> String {
        let first = spawnToFirstByteMs.map(String.init) ?? "none"
        return "[timing] clickToSpawnMs=\(clickToSpawnMs) spawnToFirstByteMs=\(first) spawnToExitMs=\(spawnToExitMs) session=\(session)"
    }
}
