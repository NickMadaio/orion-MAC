//
//  The cases that make the two-clock design worth the trouble.
//
//  Sleep, reboot, a crash mid-phase, DST, a user dragging the system date, and
//  the same command arriving twice. Each of these has a defensible answer and
//  none of them is "whatever the arithmetic happens to do".
//

import XCTest
@testable import SessionDomain

final class AdversarialTests: XCTestCase {

    // MARK: Duplicate commands

    func testTheSameRequestTwiceIsAppliedOnce() {
        let harness = Harness()
        harness.start()
        harness.advance(seconds: 30)

        let request = RequestID("pause-once")
        let first = harness.send(.pause, requestID: request)
        let second = harness.send(.pause, requestID: request)

        XCTAssertTrue(first.applied)
        XCTAssertFalse(second.applied)
        XCTAssertTrue(second.wasDuplicate, "a retry is success from the caller's side")
        XCTAssertEqual(harness.state?.events.filter { $0.kind == .paused }.count, 1)
    }

    /// The specific ordering the reducer's header calls out: a retry of a
    /// terminal command must read as "already done", not as "the session is
    /// over". The caller did succeed; they just did not hear about it.
    func testARetriedFinishReadsAsAlreadyAppliedRatherThanAsFinished() {
        let harness = Harness()
        harness.start()
        let request = RequestID("finish-once")

        harness.send(.finishEarly, requestID: request)
        let retry = harness.send(.finishEarly, requestID: request)

        XCTAssertEqual(retry.rejection, .alreadyApplied(request))
        XCTAssertNotEqual(retry.rejection, .sessionFinished(SessionID("S1")))
    }

    func testTwoDifferentFinishRequestsDoNotBothArchive() {
        let harness = Harness()
        harness.start()

        harness.send(.finishEarly, requestID: RequestID("finish-a"))
        let second = harness.send(.finishEarly, requestID: RequestID("finish-b"))

        XCTAssertFalse(second.applied)
        XCTAssertEqual(harness.now().effects.historyRecords.count, 1,
                       "exactly one history record per session, ever")
    }

    // MARK: Duplicate terminal effects

    func testAnAcknowledgedEffectIsNeverEmittedAgain() {
        let harness = Harness()
        harness.start()

        let before = harness.now().effects
        XCTAssertFalse(before.isEmpty)

        harness.drainEffects()

        XCTAssertTrue(harness.now().effects.isEmpty,
                      "acknowledged effects must not come back")
    }

    func testTheHistoryRecordIsEmittedOnceEvenAcrossManyReconciliations() {
        let harness = Harness()
        harness.start()
        harness.advance(minutes: 1)
        harness.send(.finishEarly)

        XCTAssertEqual(harness.now().effects.historyRecords.count, 1)

        harness.drainEffects()

        // Reconcile repeatedly, the way a crash-and-restart loop would.
        for _ in 0..<5 {
            XCTAssertEqual(harness.now().effects.historyRecords.count, 0,
                           "a crash after acknowledgement must not write a second record")
        }
    }

    func testAnUnacknowledgedEffectSurvivesToBeRetried() {
        let harness = Harness()
        harness.start()
        harness.advance(minutes: 1)
        harness.send(.finishEarly)

        // The service crashed before acknowledging.
        XCTAssertEqual(harness.now().effects.historyRecords.count, 1)
        XCTAssertEqual(harness.now().effects.historyRecords.count, 1,
                       "still pending, because nobody said it was done")
    }

    func testAStaleAnnouncementForAnOvertakenPhaseIsNotReplayed() {
        let harness = Harness()
        harness.start()
        harness.drainEffects()

        // The app is shut for long enough that two boundaries pass unheard.
        harness.advance(minutes: 4)

        let announcements = harness.now().effects.announcements
        XCTAssertEqual(announcements.count, 1,
                       "only the phase that is actually current gets announced")
        if case .focusBeginning(let block, _, _) = announcements[0] {
            XCTAssertEqual(block, 2, "and it is the current one, not the one we missed")
        } else {
            XCTFail("expected a focus announcement, got \(announcements)")
        }
    }

    // MARK: Process restart

    func testTimeWhileTheAppWasNotRunningDoesNotCountAsFocus() {
        let harness = Harness()
        harness.start()
        harness.advance(seconds: 30)

        // The app dies here. Thirty minutes pass. It comes back.
        harness.advanceWhileDown(minutes: 30)
        harness.noteProcessStart()

        XCTAssertEqual(harness.now().servedInPhase, 30, accuracy: 0.001,
                       "downtime is not focus")
        XCTAssertEqual(harness.now().uncounted, 1800, accuracy: 0.001)
        XCTAssertEqual(harness.status, .running(.focus))
    }

    func testALongDowntimePromptsRatherThanBeingAbsorbed() {
        let harness = Harness()
        harness.start()
        harness.advance(seconds: 30)
        harness.advanceWhileDown(minutes: 30)
        harness.noteProcessStart()

        let absences = harness.now().effects.absences
        XCTAssertEqual(absences.count, 1)
        XCTAssertEqual(absences[0], 1800, accuracy: 0.001)
    }

    func testAShortDowntimeDoesNotNagAboutIt() {
        let harness = Harness()
        harness.start()
        harness.advance(seconds: 30)
        harness.advanceWhileDown(seconds: 20)
        harness.noteProcessStart()

        XCTAssertTrue(harness.now().effects.absences.isEmpty,
                      "twenty seconds is a relaunch, not an absence")
        XCTAssertEqual(harness.now().uncounted, 20, accuracy: 0.001,
                       "but it still does not count as focus")
    }

    func testTheSessionSurvivesARebootIntact() {
        let harness = Harness()
        harness.start()
        harness.advance(seconds: 45)

        harness.reboot(after: 10 * 60)
        harness.noteProcessStart()

        XCTAssertEqual(harness.state?.id, SessionID("S1"))
        XCTAssertEqual(harness.now().servedInPhase, 45, accuracy: 0.001)
        XCTAssertEqual(harness.status, .running(.focus))
    }

    // MARK: Sleep

    func testAShortSleepCounts() {
        // The lid was shut for two minutes with the app still running. That is
        // two minutes that passed, and the monotonic clock is right to say so.
        let harness = Harness()
        harness.start(Harness.fullPlan())
        harness.advance(minutes: 10)

        harness.advance(minutes: 2)

        XCTAssertEqual(harness.now().servedInPhase, 12 * 60, accuracy: 0.001)
    }

    func testALongAbsenceAcrossARestartIsNotCountedAsFocus() {
        let harness = Harness()
        harness.start(Harness.fullPlan())
        harness.advance(minutes: 5)

        // Lid shut overnight; the machine rebooted; the app came back.
        harness.reboot(after: 8 * 3600)
        harness.noteProcessStart()

        XCTAssertEqual(harness.now().servedInPhase, 5 * 60, accuracy: 0.001,
                       "eight hours asleep is not eight hours of focus")
        XCTAssertEqual(harness.now().effects.absences.count, 1)
    }

    // MARK: The wall clock moving

    func testDraggingTheWallClockForwardDoesNotAddServedMinutes() {
        let harness = Harness()
        harness.start(Harness.fullPlan())
        harness.advance(minutes: 10)

        harness.dragWallClock(by: 3600)

        XCTAssertEqual(harness.now().servedInPhase, 10 * 60, accuracy: 0.001,
                       "an hour that did not happen cannot be served")
        XCTAssertEqual(harness.status, .running(.focus))
    }

    func testDraggingTheWallClockBackwardsDoesNotRemoveServedMinutes() {
        let harness = Harness()
        harness.start(Harness.fullPlan())
        harness.advance(minutes: 10)

        harness.dragWallClock(by: -3600)

        XCTAssertEqual(harness.now().servedInPhase, 10 * 60, accuracy: 0.001,
                       "and it cannot unserve them either")
    }

    /// DST is the same mechanism as a dragged clock, and it is the one that
    /// happens to everybody twice a year without anybody doing anything.
    func testDaylightSavingDoesNotDistortServedTime() {
        let harness = Harness()
        harness.start(Harness.fullPlan())
        harness.advance(minutes: 20)

        harness.dragWallClock(by: 3600)   // spring forward
        harness.advance(minutes: 10)

        XCTAssertEqual(harness.now().servedInPhase, 30 * 60, accuracy: 0.001)

        harness.dragWallClock(by: -3600)  // and back again
        harness.advance(minutes: 10)

        XCTAssertEqual(harness.now().servedInPhase, 40 * 60, accuracy: 0.001)
    }

    func testAClockAnomalyIsRecordedAndMakesTheRecordApproximate() {
        let harness = Harness()
        harness.start()
        harness.advance(seconds: 30)

        harness.noteClockAnomaly(seconds: 3600)

        XCTAssertTrue(harness.now().approximate)
        harness.send(.finishEarly)
        XCTAssertEqual(harness.now().effects.historyRecords.first?.approximate, true)
    }

    func testASmallClockCorrectionIsNotTreatedAsAnAnomaly() {
        let harness = Harness()
        harness.start()

        harness.noteClockAnomaly(seconds: 5)

        XCTAssertFalse(harness.now().approximate,
                       "NTP nudging by five seconds is drift, not a clock change")
    }

    // MARK: Window close

    func testClosingTheWindowIsANoOp() {
        // There is deliberately no command for it. This test exists to pin the
        // policy: nothing in the vocabulary can express "the window closed", so
        // closing the dashboard cannot affect a session even by accident.
        let harness = Harness()
        harness.start()
        harness.advance(minutes: 1)
        let before = harness.now()

        // Whatever the UI does on close, the domain sees nothing.
        let after = harness.now()

        XCTAssertEqual(before.servedInPhase, after.servedInPhase)
        XCTAssertEqual(before.status, after.status)
    }

    // MARK: Staleness

    /// Fixed UTC-5 so day-rollover results do not depend on the machine's zone.
    /// Harness time starts 07:00 in it, so 18 h later is 01:00 -- still the same
    /// logical day (the cutoff is 04:00).
    private func withFixedRolloverCalendar(_ body: () -> Void) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: -5 * 3600)!
        SessionReconciler.rolloverCalendar = calendar
        defer { SessionReconciler.rolloverCalendar = nil }
        body()
    }

    func testAPausedSessionSurvivesANightButNotTwo() {
        withFixedRolloverCalendar { aPausedSessionSurvivesANight() }
    }

    private func aPausedSessionSurvivesANight() {
        // The design is that a paused session waits forever -- "closing the
        // dashboard is not leaving the session". That is right for an hour and
        // wrong for a fortnight: a real session paused 2026-08-12 was still
        // paused on 2026-09-01, accruing heartbeats for twenty days.
        let harness = Harness()
        harness.start()
        harness.advance(seconds: 30)
        harness.send(.pause)

        harness.advanceWhileDown(seconds: SessionReconciler.staleAfter - 60)
        XCTAssertEqual(harness.status, .paused,
                       "parked overnight is still a session")

        harness.advanceWhileDown(seconds: 120)
        XCTAssertEqual(harness.status, .readyToAbandon,
                       "past the threshold nobody is coming back")
    }

    func testHeartbeatsDoNotKeepAStaleSessionAlive() {
        // The wedged session had 60 processAlive events and 48 processStarted
        // events after its last pause. A process saying "still here" is not
        // evidence that a person intends to resume -- but it IS the freshest
        // thing in the log, so the rule measures from it and can only ever fire
        // later than it otherwise would, never sooner.
        let harness = Harness()
        harness.start()
        harness.advance(seconds: 30)
        harness.send(.pause)

        withFixedRolloverCalendar {
            // Restarts every 4.5 h used to reset the clock forever. The pause
            // is now measured from when it began, so they no longer can.
            for _ in 0..<3 {
                harness.advanceWhileDown(seconds: SessionReconciler.staleAfter / 4)
                _ = harness.noteProcessStart()
            }
            XCTAssertEqual(harness.status, .paused, "13.5 h in, still inside the window")

            harness.advanceWhileDown(seconds: SessionReconciler.staleAfter / 4)
            _ = harness.noteProcessStart()
            harness.advanceWhileDown(seconds: SessionReconciler.staleAfter / 4)
            _ = harness.noteProcessStart()
            XCTAssertEqual(harness.status, .readyToAbandon,
                           "heartbeats and restarts do not keep a pause alive past 18 h")
        }
    }

    func testPausedAtIsThePauseStartNotTheLastHeartbeat() {
        let harness = Harness()
        harness.start()
        harness.advance(seconds: 30)
        harness.send(.pause)
        let pauseWall = harness.wall.now
        harness.advance(minutes: 10)
        _ = harness.noteProcessStart()
        let now = harness.now()
        XCTAssertEqual(now.status, .paused)
        XCTAssertEqual(now.pausedAt, pauseWall)
    }

    func testResumeClearsPausedAt() {
        let harness = Harness()
        harness.start()
        harness.advance(seconds: 30)
        harness.send(.pause)
        harness.advance(minutes: 1)
        harness.send(.resume)
        XCTAssertNil(harness.now().pausedAt)
    }

    func testAPauseAcrossTheDayRolloverExpires() {
        // Paused at 23:00 (UTC-5): at 04:10 the next morning it is a new logical
        // day, so the pause is a leftover though only five hours old.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: -5 * 3600)!
        SessionReconciler.rolloverCalendar = calendar
        defer { SessionReconciler.rolloverCalendar = nil }

        let harness = Harness()
        harness.start(Harness.fullPlan())
        harness.advance(seconds: 30)
        harness.advanceWhileDown(seconds: 16 * 3600 - 30)   // 23:00 local
        _ = harness.noteProcessStart()
        harness.send(.pause)
        harness.advanceWhileDown(seconds: 4 * 3600)         // 03:00, same logical day
        XCTAssertEqual(harness.status, .paused)
        harness.advanceWhileDown(seconds: 70 * 60)          // 04:10, new day
        XCTAssertEqual(harness.status, .readyToAbandon)
    }

    func testAShortPauseStraddlingTheRolloverSurvives() {
        // Paused at 03:55 (UTC-5): five minutes later it is 04:00, a new logical
        // day. A pause that short is a coffee, not yesterday's leftover, and
        // abandoning it would end the session for good.
        withFixedRolloverCalendar {
            let harness = Harness()
            harness.start(Harness.fullPlan())
            harness.advance(seconds: 30)
            harness.advanceWhileDown(seconds: 20 * 3600 + 55 * 60 - 30)  // 03:55 local
            _ = harness.noteProcessStart()
            harness.send(.pause)
            harness.advanceWhileDown(seconds: 5 * 60)                    // 04:00
            XCTAssertEqual(harness.status, .paused,
                           "a five-minute pause across 04:00 is still a session")
            harness.advanceWhileDown(seconds: 2 * 3600)                  // 06:00
            XCTAssertEqual(harness.status, .paused,
                           "still under the minimum pause length")
            harness.advanceWhileDown(seconds: SessionReconciler.minimumPauseBeforeRolloverExpiry)
            XCTAssertEqual(harness.status, .readyToAbandon,
                           "crossed the rollover and lasted past the minimum")
        }
    }

    func testAPauseFromThePreviousEveningExpiresNextMorning() {
        withFixedRolloverCalendar {
            let harness = Harness()
            harness.start(Harness.fullPlan())
            harness.advance(seconds: 30)
            harness.advanceWhileDown(seconds: 14 * 3600 - 30)            // 21:00 local
            _ = harness.noteProcessStart()
            harness.send(.pause)
            harness.advanceWhileDown(seconds: 11 * 3600)                 // 08:00 next day
            XCTAssertEqual(harness.status, .readyToAbandon)
        }
    }

    func testARunningSessionAcrossTheRolloverIsNeverAbandoned() {
        withFixedRolloverCalendar {
            // Starts 03:50 local and runs through 04:00 without a pause.
            let harness = Harness(start: Harness.defaultStart.addingTimeInterval(20 * 3600 + 50 * 60))
            harness.start(Harness.fullPlan())
            harness.advance(minutes: 20)                                 // 04:10
            XCTAssertEqual(harness.status, .running(.focus))
            XCTAssertNil(harness.now().pausedAt)
        }
    }

    func testRolloverHelperUsesTheFourAmCutoff() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let day = Date(timeIntervalSince1970: 1_772_452_800)   // 2026-03-02 12:00 UTC
        XCTAssertFalse(SessionReconciler.crossedDayRollover(
            from: day, to: day.addingTimeInterval(15 * 3600), calendar: calendar))   // 03:00 next day
        XCTAssertTrue(SessionReconciler.crossedDayRollover(
            from: day, to: day.addingTimeInterval(16.5 * 3600), calendar: calendar)) // 04:30 next day
    }

    func testAServedSessionIsCompletedNotAbandoned() {
        // Ordering matters: a session that served all its time and then sat
        // unarchived is finished, not walked away from. Abandoning it would
        // record a failure where there was a success.
        let harness = Harness()
        harness.start(Harness.shortPlan())
        harness.advanceWhileDown(seconds: SessionReconciler.staleAfter * 2)
        XCTAssertNotEqual(harness.status, .readyToAbandon,
                          "time served is not abandonment")
    }

    func testAbandonIfStaleWritesTheTerminalEvent() {
        // The log stays the record: the reducer emits the event rather than the
        // arithmetic implying it, exactly as completeIfServed does.
        let harness = Harness()
        harness.start()
        harness.advance(seconds: 30)
        harness.send(.pause)
        harness.advanceWhileDown(seconds: SessionReconciler.staleAfter + 60)

        let result = SessionReducer.abandonIfStale(
            harness.state,
            requestID: RequestID("abandon-stale-test"),
            clocks: harness.clocks
        )
        XCTAssertTrue(result.applied)
        XCTAssertEqual(result.state?.events.finish?.reason, .abandoned)
        XCTAssertFalse(FinishReason.abandoned.isSuccess,
                       "a stale session must never score as a completed one")
    }

    // MARK: Combinations

    func testPauseAcrossARestartStaysPaused() {
        let harness = Harness()
        harness.start()
        harness.advance(seconds: 30)
        harness.send(.pause)

        harness.advanceWhileDown(minutes: 20)
        harness.noteProcessStart()

        XCTAssertEqual(harness.status, .paused, "a restart does not resume anything")
        XCTAssertEqual(harness.now().servedInPhase, 30, accuracy: 0.001)
    }

    func testIdleHoldSurvivesARestart() {
        let harness = Harness()
        harness.start()
        harness.advance(minutes: 2)
        harness.send(.noteIdle)
        harness.advance(minutes: 1)
        XCTAssertEqual(harness.status, .waitingForReturn(afterRestIndex: 1))

        harness.advanceWhileDown(minutes: 15)
        harness.noteProcessStart()

        XCTAssertEqual(harness.status, .waitingForReturn(afterRestIndex: 1),
                       "he still has not come back, so it is still waiting")
    }
}
