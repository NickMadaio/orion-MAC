import XCTest
@testable import MobileCore

final class TurnMarksTests: XCTestCase {
    func test_thinking_rejection_retries_with_off() {
        let err = "Thinking level \"low\" is not supported for ollama/qwen3.5:9b"
        XCTAssertEqual(ThinkingFallback.retryLevel(stderr: err, usedLevel: "low"), "off")
    }

    func test_already_off_or_other_errors_do_not_retry() {
        let err = "Thinking level \"off\" is not supported for x"
        XCTAssertNil(ThinkingFallback.retryLevel(stderr: err, usedLevel: "off"))
        XCTAssertNil(ThinkingFallback.retryLevel(stderr: "gateway timeout", usedLevel: "low"))
        XCTAssertNil(ThinkingFallback.retryLevel(stderr: "", usedLevel: "low"))
    }

    func test_only_the_thinking_preflight_rejection_matches() {
        // Another "is not supported for" error is not the thinking rejection,
        // and retrying it with thinking off would hide the real failure.
        let other = "Attachment type image/heic is not supported for this model"
        XCTAssertNil(ThinkingFallback.retryLevel(stderr: other, usedLevel: "low"))
        XCTAssertFalse(ThinkingFallback.isThinkingRejection(other))
        let wrongOrder = "is not supported for x: Thinking level \"low\""
        XCTAssertFalse(ThinkingFallback.isThinkingRejection(wrongOrder))
        let real = "Error: Thinking level \"medium\" is not supported for ollama/qwen3.5:9b"
        XCTAssertTrue(ThinkingFallback.isThinkingRejection(real))
        XCTAssertEqual(ThinkingFallback.retryLevel(stderr: real, usedLevel: "medium"), "off")
    }

    func test_marks_split_the_turn_and_carry_no_text() {
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        let marks = TurnMarks(sent: t0, spawned: t0.addingTimeInterval(0.25),
                              firstByte: t0.addingTimeInterval(5.25), exited: t0.addingTimeInterval(5.75))
        XCTAssertEqual(marks.clickToSpawnMs, 250)
        XCTAssertEqual(marks.spawnToFirstByteMs, 5000)
        XCTAssertEqual(marks.spawnToExitMs, 5500)
        XCTAssertEqual(marks.logLine(session: "orion-app-v2"),
                       "[timing] clickToSpawnMs=250 spawnToFirstByteMs=5000 spawnToExitMs=5500 session=orion-app-v2")
    }

    func test_no_output_and_backwards_clock_are_safe() {
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        let marks = TurnMarks(sent: t0, spawned: t0.addingTimeInterval(-1), firstByte: nil, exited: t0)
        XCTAssertEqual(marks.clickToSpawnMs, 0)
        XCTAssertNil(marks.spawnToFirstByteMs)
        XCTAssertTrue(marks.logLine(session: "s").contains("spawnToFirstByteMs=none"))
    }
}
