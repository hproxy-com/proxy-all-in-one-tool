import XCTest
@testable import HProxy

/// The real engine under the Swift models, on the Simulator. A tunnel does not run
/// there, so this proves everything up to the tunnel: the doors, the JSON, the words.
final class AppTests: XCTestCase {
    private let line = "198.51.100.7:8080:user:pass"

    override func setUp() async throws {
        try await Engine.start(inTunnel: false)
    }

    private func add(_ text: String) async throws -> Library {
        let answer = try await Engine.call("add", ["text": text, "asGroup": false])
        let library = try XCTUnwrap((answer as? [String: Any])?["library"])
        return try Engine.decode(Library.self, from: library)
    }

    func testAPasteComesBackAsModels() async throws {
        let review = try await Engine.call("review", ["text": line]) as? [String: Any]
        XCTAssertEqual(review?["proxies"] as? Int, 1)

        let library = try await add(line)
        let proxy = try XCTUnwrap(library.proxies.first { $0.address == "198.51.100.7:8080" })
        XCTAssertEqual(proxy.title, "198.51.100.7:8080")
        XCTAssertEqual(library.switchTo, .proxy(proxy.id))

        let gone = try await Engine.call("forget", ["id": proxy.id])
        let after = try Engine.decode(Library.self, from: gone)
        XCTAssertFalse(after.proxies.contains { $0.id == proxy.id })
    }

    func testASessionIsTheTitle() throws {
        let data = Data(#"{"id":"a","address":"gate.example:7000","about":{"session":"7f3a9c21"}}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(ProxyItem.self, from: data).title, "Session 7f3a9c21")
    }

    func testAProxyThatIsDownIsNamed() async throws {
        let library = try await add("127.0.0.1:9")
        let proxy = try XCTUnwrap(library.proxies.first { $0.address == "127.0.0.1:9" })
        do {
            try await Engine.call("connect", ["place": Place.proxy(proxy.id).json])
            XCTFail("a closed port connected")
        } catch {
            XCTAssertFalse(ErrorWords(error.localizedDescription).name.isEmpty, error.localizedDescription)
        }
        try await Engine.call("forget", ["id": proxy.id])
    }

    func testStatusReadsWhileOff() async throws {
        let status = try Engine.decode(Status.self, from: try await Engine.call("status"))
        XCTAssertFalse(status.running)
    }

    /// The network the tunnel sets up, read the way it reads it.
    func testTheTunnelsNetwork() async throws {
        let network = try await Engine.call("vpnArgs") as? [String: Any]
        let addresses = (network?["addresses"] as? [String] ?? []).compactMap(Route.init)
        XCTAssertEqual(addresses.first { !$0.isV6 }?.mask, "255.255.255.255")
        XCTAssertNotNil(addresses.first(where: \.isV6))
        let routes = network?["routes"] as? [String] ?? []
        XCTAssertFalse(routes.isEmpty)
        XCTAssertEqual(routes.compactMap(Route.init).count, routes.count)
        XCTAssertTrue(routes.compactMap(Route.init).contains(where: \.isV6), "IPv6 would go around the tunnel")
        XCTAssertNotNil(network?["dns"] as? String)
        XCTAssertNotNil(network?["mtu"] as? NSNumber)
    }

    func testMasks() {
        XCTAssertEqual(Route("10.0.0.0/8")?.mask, "255.0.0.0")
        XCTAssertEqual(Route("192.0.0.0/2")?.mask, "192.0.0.0")
        XCTAssertEqual(Route("0.0.0.0/0")?.mask, "0.0.0.0")
        XCTAssertEqual(Route("172.0.0.0/12")?.mask, "255.240.0.0")
        XCTAssertNil(Route("nonsense"))
    }

    func testErrorWords() {
        let words = ErrorWords("timed out: the proxy did not answer")
        XCTAssertEqual(words.name, "Timed out")
        XCTAssertEqual(words.detail, "The proxy did not answer")
        XCTAssertEqual(words.line, "Timed out: The proxy did not answer")
        XCTAssertEqual(ErrorWords("no colon here").name, "")
    }

    func testTheWorld() {
        XCTAssertFalse(World.countries["de", default: []].isEmpty)
        XCTAssertGreaterThan(World.land.count, 500)
        XCTAssertTrue(World.land.allSatisfy { $0 >= 0 && $0 < WorldData.cols * WorldData.rows })
    }

    func testALastErrorIsKeptUntilRead() {
        Engine.lastError = "timed out: test"
        XCTAssertEqual(Engine.lastError, "timed out: test")
        Engine.lastError = nil
        XCTAssertNil(Engine.lastError)
    }

    /// The Checker: a paste becomes a run with one card per proxy, the run ends by itself,
    /// and it is kept among the recent checks with its lines (checker.rs). The host app's
    /// own pump may read the run's events, so this looks at what the engine keeps.
    @MainActor
    func testTheCheckerRunsAPaste() async throws {
        let checker = CheckerModel()
        let refused = await checker.start(text: "127.0.0.1:9")
        XCTAssertNil(refused)
        let run = try XCTUnwrap(checker.run)
        XCTAssertEqual(run.cards.map(\.address), ["127.0.0.1:9"])
        XCTAssertEqual(run.stage, .running)

        var kept: CheckSummary?
        let deadline = Date().addingTimeInterval(45)
        while kept == nil, Date() < deadline {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            await checker.refreshRecent()
            kept = checker.recent.first { $0.id == run.id }
        }
        let summary = try XCTUnwrap(kept, "the run never finished")
        XCTAssertEqual(summary.total, 1)
        XCTAssertEqual(summary.working + summary.slow, 0, "a closed port counted as working")
        let lines = await checker.lines(run.cards)
        XCTAssertEqual(lines.first, "127.0.0.1:9")
    }

    /// The support chat keeps the thread from the engine's "chat" events. Events only: a test
    /// never opens the real chat, so support's inbox gets nothing from it.
    @MainActor
    func testTheChatKeepsTheThread() {
        defer { UserDefaults.standard.removeObject(forKey: "chatToken") }
        let chat = SupportChat()
        chat.handle(["type": "chat", "kind": "ready", "token": "t", "conversation": "c1", "online": true, "replyTime": "1-3 minutes"])
        XCTAssertEqual(chat.link, .open)
        XCTAssertTrue(chat.online)
        XCTAssertEqual(chat.replyTime, "1-3 minutes")
        chat.handle(["type": "chat", "kind": "message", "message": [
            "id": "m1", "body": "Hello", "author_type": "agent", "author_name": "Sam", "created_at": "2026-11-16T18:00:00.123Z",
        ]])
        chat.handle(["type": "chat", "kind": "message", "message": ["id": "m2", "body": "note", "is_internal": true]])
        XCTAssertEqual(chat.messages.map(\.body), ["Hello"], "an internal note never shows")
        XCTAssertFalse(chat.messages[0].mine)
        XCTAssertEqual(chat.messages[0].by, "Sam")
        XCTAssertFalse(chat.send("Idea: "), "a starter alone is not sent")
        chat.handle(["type": "chat", "kind": "down"])
        XCTAssertEqual(chat.link, .down)
    }

    /// A last day comes back on the proxy, and the engine names the reminder due three days
    /// before it (what Reminders.swift plans).
    func testALastDayCallsForAReminder() async throws {
        let library = try await add("198.51.100.9:8080")
        let proxy = try XCTUnwrap(library.proxies.first { $0.address == "198.51.100.9:8080" })
        let described = try await Engine.call("describe", ["ids": [proxy.id], "details": ["expires": "2030-01-15"]])
        let after = try Engine.decode(Library.self, from: described)
        XCTAssertEqual(after.proxies.first { $0.id == proxy.id }?.expires, "2030-01-15")
        let due = try await Engine.call("remindersDue", ["today": "2030-01-12"]) as? [[String: Any]] ?? []
        XCTAssertTrue(due.contains { ($0["body"] as? String)?.contains("expires") == true }, "\(due)")
        XCTAssertEqual(Reminders.words(Reminders.written(Date()))?.words, "Ends today")
        try await Engine.call("forget", ["id": proxy.id])
    }

    /// A card turns by what its answer says (CheckerState.kt's faces).
    func testFaces() {
        XCTAssertEqual(CheckAnswer(["alive": false]).face, .dead)
        XCTAssertEqual(CheckAnswer(["alive": true, "carries": true, "tone": "good"]).face, .good)
        XCTAssertEqual(CheckAnswer(["alive": true, "carries": true, "tone": "warn"]).face, .slow)
        XCTAssertEqual(CheckAnswer(["alive": true, "carries": false, "tone": "bad", "notes": ["plain_http_only"]]).face, .noHttps)
        XCTAssertEqual(CheckAnswer(["alive": true, "carries": true, "tone": "good", "site": ["verdict": "refuses", "why": "captcha"]]).face, .blocked)
        XCTAssertEqual(flag("de"), "🇩🇪")
        XCTAssertEqual(speedWords(180), "180 ms")
        XCTAssertEqual(speedWords(1600), "1.6 s")
    }
}
