import SwiftUI

/// How a checked proxy reads on its card, as on the phone app (CheckerState.kt, 5 · Flip).
enum Face {
    case good, slow, noHttps, reads, blocked, bad, dead
}

/// One answer, as the engine sends it (proxy-engine/hproxy-mobile, checker.rs `Row`).
struct CheckAnswer: Equatable {
    var alive: Bool
    var carries: Bool
    var tone: String
    var says: String
    var why: String?
    var notes: [String]
    var ms: Int?
    var way: String?
    var exitIp: String?
    var cc: String?
    var country: String?
    var city: String?
    var datacenter: Bool?
    var anonymity: String?
    var protocols: [String]
    var error: String?
    /// "opens", "refuses" or "unknown", when a site was asked.
    var site: String?
    var siteWhy: String?

    init(_ o: [String: Any]) {
        alive = o["alive"] as? Bool ?? false
        carries = o["carries"] as? Bool ?? false
        tone = o["tone"] as? String ?? ""
        says = o["says"] as? String ?? ""
        why = o["why"] as? String
        notes = o["notes"] as? [String] ?? []
        ms = o["ms"] as? Int
        way = o["way"] as? String
        exitIp = o["exitIp"] as? String
        cc = o["cc"] as? String
        country = o["country"] as? String
        city = o["city"] as? String
        datacenter = o["datacenter"] as? Bool
        anonymity = o["anonymity"] as? String
        protocols = o["protocols"] as? [String] ?? []
        error = o["error"] as? String
        let site = o["site"] as? [String: Any]
        self.site = site?["verdict"] as? String
        siteWhy = site?["why"] as? String
    }

    var face: Face {
        if !alive { return .dead }
        if site == "refuses" { return .blocked }
        if notes.contains("plain_http_only") { return .noHttps }
        if notes.contains("reads_https") { return .reads }
        if !carries || tone == "bad" { return .bad }
        if tone == "warn" { return .slow }
        return .good
    }

    /// Where it comes out, in words: "Frankfurt, Germany".
    var whereWords: String? {
        let land = country ?? cc.flatMap { Locale.current.localizedString(forRegionCode: $0.uppercased()) }
        let words = [city, land].compactMap { $0 }.joined(separator: ", ")
        return words.isEmpty ? nil : words
    }
}

/// A card: one proxy of the run, face down until its answer lands.
struct CheckCard: Identifiable, Equatable {
    let i: Int
    let address: String
    /// Where the proxy's own address is, for the flag face down.
    var cc: String?
    var answer: CheckAnswer?

    var id: Int { i }

    /// Working: it carried the check, fast (green) or with a warning (amber).
    var works: Bool { answer?.face == .good || answer?.face == .slow }

    /// The usual order of a finished run: working, slow, unusable, not answered, dead.
    var rank: Int {
        switch answer?.face {
        case nil: return 3
        case .good: return 0
        case .slow: return 1
        case .dead: return 4
        default: return 2
        }
    }
}

struct CheckSummary: Identifiable, Equatable {
    let id: Int
    /// Milliseconds since 1970.
    let at: Int
    let total: Int
    let working: Int
    let slow: Int
    let bad: Int
    let dead: Int
}

struct CheckRun: Equatable {
    enum Stage { case running, done }

    let id: Int
    var cards: [CheckCard]
    var stage: Stage
    /// Lines that were not proxies, and repeats.
    let invalid: Int
    let repeated: Int

    var working: [CheckCard] {
        cards.filter(\.works).sorted { ($0.rank, $0.answer?.ms ?? .max) < ($1.rank, $1.answer?.ms ?? .max) }
    }

    var ordered: [CheckCard] {
        cards.sorted { a, b in
            let ka = a.rank <= 1 ? (a.answer?.ms ?? 0) : a.i
            let kb = b.rank <= 1 ? (b.answer?.ms ?? 0) : b.i
            return (a.rank, ka) < (b.rank, kb)
        }
    }
}

/// Who answers each proxy with what it saw: the checker's one choice (Settings.kt `JudgeKind`).
enum JudgeKind: String, CaseIterable, Identifiable {
    case hproxy, cloudflare, own

    var id: String { rawValue }

    var label: String {
        switch self {
        case .hproxy: return "HProxy"
        case .cloudflare: return "Cloudflare"
        case .own: return "Your own judge"
        }
    }

    var about: String {
        switch self {
        case .hproxy: return "Sees the address you appear as and every header, so it can tell how well a proxy hides you"
        case .cloudflare: return "Sees the address you appear as"
        case .own: return "Any address of yours that answers, typed in"
        }
    }
}

/// The checker: the run on the screen, its cards as the answers land, and the recent runs.
/// The lines themselves stay in the engine; copying, sharing or saving asks for them.
@MainActor
final class CheckerModel: ObservableObject {
    @Published var run: CheckRun?
    @Published var recent: [CheckSummary] = []

    /// The judge as the Judge sheet saved it (`judgeKind`, `judgeURL`, the screens'
    /// @AppStorage), as the engine's checker takes it (`StartInput.judge`).
    private var judge: [String: Any] {
        let saved = UserDefaults.standard
        let kind = JudgeKind(rawValue: saved.string(forKey: "judgeKind") ?? "") ?? .hproxy
        guard kind == .own else { return ["kind": kind.rawValue] }
        return ["kind": "own", "url": (saved.string(forKey: "judgeURL") ?? "").trimmingCharacters(in: .whitespaces)]
    }

    /// Check pasted text, a saved group, every saved proxy, or a recent run again. The
    /// engine's words come back when it refused.
    func start(text: String? = nil, group: String? = nil, saved: Bool = false, again: Int? = nil) async -> String? {
        var args: [String: Any] = ["site": "any", "judge": judge]
        if let text { args["text"] = text }
        if let group { args["group"] = group }
        if saved { args["saved"] = true }
        if let again { args["again"] = again }
        do {
            let value = try await Engine.call("checkStart", args)
            guard let o = value as? [String: Any], let id = o["run"] as? Int else { return "The checker did not start" }
            let items = (o["items"] as? [[String: Any]]) ?? []
            run = CheckRun(
                id: id,
                cards: items.map { CheckCard(i: $0["i"] as? Int ?? 0, address: $0["address"] as? String ?? "") },
                stage: .running,
                invalid: o["invalid"] as? Int ?? 0,
                repeated: o["repeated"] as? Int ?? 0
            )
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func cancel() async {
        _ = try? await Engine.call("checkCancel")
        run?.stage = .done
    }

    func reset() {
        run = nil
    }

    /// The lines of these cards, as they were pasted (Copy, Save, Use, Again).
    func lines(_ cards: [CheckCard]) async -> [String] {
        guard let run else { return [] }
        let value = try? await Engine.call("checkLines", ["run": run.id, "which": cards.map(\.i)])
        return value as? [String] ?? []
    }

    func refreshRecent() async {
        guard let value = try? await Engine.call("checkRecent"), let list = value as? [[String: Any]] else { return }
        recent = list.map {
            CheckSummary(
                id: $0["id"] as? Int ?? 0,
                at: $0["at"] as? Int ?? 0,
                total: $0["total"] as? Int ?? 0,
                working: $0["working"] as? Int ?? 0,
                slow: $0["slow"] as? Int ?? 0,
                bad: $0["bad"] as? Int ?? 0,
                dead: $0["dead"] as? Int ?? 0
            )
        }
    }

    #if DEBUG
    /// The store's pictures (AppModel.showDemo): a run of example addresses (RFC 5737) with
    /// every kind of answer, its cards turned over. Never in a release build.
    func showDemo() {
        // The cards agree with the example library (AppModel.showDemo): a saved proxy's
        // name, place and protocol are the same on every screen. A dead proxy has no way.
        func answer(_ ms: Int?, _ cc: String, _ city: String, way: String = "http", tone: String = "good", notes: [String] = [], alive: Bool = true) -> CheckAnswer {
            var o: [String: Any] = [
                "alive": alive, "carries": alive && tone != "bad", "tone": tone, "notes": notes,
                "says": alive ? (tone == "warn" ? "Working, slow" : "Working") : "No answer",
                "cc": cc.lowercased(), "city": city,
            ]
            if alive { o["way"] = way }
            var a = CheckAnswer(o)
            a.ms = ms
            if !alive { a.error = "timed out: the proxy did not answer in time" }
            return a
        }
        let rows: [(String, CheckAnswer)] = [
            ("203.0.113.24:8080", answer(84, "US", "New York")),
            ("198.51.100.7:1080", answer(112, "GB", "London", way: "socks5")),
            ("192.0.2.61:8000", answer(143, "DE", "Berlin")),
            ("203.0.113.90:3128", answer(201, "NL", "Amsterdam")),
            ("198.51.100.33:8080", answer(1840, "FR", "Paris", tone: "warn", notes: ["slow"])),
            ("192.0.2.14:9050", answer(nil, "BR", "São Paulo", alive: false)),
            ("203.0.113.5:8888", answer(96, "CA", "Toronto")),
            ("198.51.100.81:3128", answer(nil, "IN", "Mumbai", tone: "bad", notes: ["plain_http_only"])),
            ("192.0.2.200:1080", answer(167, "JP", "Tokyo", way: "socks5")),
            ("203.0.113.47:8080", answer(nil, "US", "Dallas", alive: false)),
            ("198.51.100.12:8000", answer(129, "SG", "Singapore")),
            ("192.0.2.88:3128", answer(238, "ES", "Madrid")),
        ]
        run = CheckRun(
            id: 1,
            cards: rows.enumerated().map { n, row in CheckCard(i: n, address: row.0, cc: row.1.cc, answer: row.1) },
            stage: .done,
            invalid: 0,
            repeated: 0
        )
    }
    #endif

    /// An event of the engine's (`check`, `checkGeo`, `checkDone`), for the run on screen.
    func handle(_ e: [String: Any]) {
        guard var r = run, e["quiet"] as? Bool != true, e["run"] as? Int == r.id else { return }
        switch e["type"] as? String {
        case "check":
            guard let row = e["row"] as? [String: Any], let i = row["i"] as? Int,
                  let n = r.cards.firstIndex(where: { $0.i == i }) else { return }
            r.cards[n].answer = CheckAnswer(row)
        case "checkGeo":
            for item in (e["items"] as? [[String: Any]]) ?? [] {
                if let i = item["i"] as? Int, let n = r.cards.firstIndex(where: { $0.i == i }) {
                    r.cards[n].cc = item["cc"] as? String
                }
            }
        case "checkDone":
            r.stage = .done
            Task { await refreshRecent() }
        default:
            return
        }
        run = r
    }
}

/// A country's flag from its two letters, for cards and rows.
func flag(_ cc: String?) -> String {
    guard let cc, cc.count == 2 else { return "" }
    return cc.uppercased().unicodeScalars
        .compactMap { UnicodeScalar(127_397 + $0.value) }
        .map { String($0) }
        .joined()
}

/// "180 ms" or "1.6 s".
func speedWords(_ ms: Int) -> String {
    ms < 1000 ? "\(ms) ms" : String(format: "%.1f s", Double(ms) / 1000)
}
