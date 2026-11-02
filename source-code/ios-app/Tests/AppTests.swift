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
}
