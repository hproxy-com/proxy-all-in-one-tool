import Foundation

/// A place to connect through, as the engine names it (hproxy_places::Place). The
/// first version connects your own proxies and groups, so there is no free place.
enum Place: Decodable, Equatable {
    case proxy(String)
    case group(String)

    private enum Keys: String, CodingKey { case kind, id }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let id = try c.decode(String.self, forKey: .id)
        self = try c.decode(String.self, forKey: .kind) == "group" ? .group(id) : .proxy(id)
    }

    var json: [String: Any] {
        switch self {
        case .proxy(let id): return ["kind": "proxy", "id": id]
        case .group(let id): return ["kind": "group", "id": id]
        }
    }

    /// The same, as text: how a tunnel's settings carry it.
    var text: String {
        let data = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}

/// What the last test of a proxy found.
struct Verdict: Decodable, Equatable {
    var ok: Bool?
    var latencyMs: Int?
    var cc: String?
    var place: String?
    var exitIp: String?
}

struct ProxyItem: Decodable, Identifiable, Equatable {
    /// What a login targets, as far as a title needs it.
    struct About: Decodable, Equatable {
        var session: String?
    }

    let id: String
    var name: String?
    var address: String
    var user: String?
    var scheme: String?
    var about: About?
    var last: Verdict?

    /// As on every other screen of ours (hproxy-places, `ProxyView::title`): its
    /// name, else its session, since a hundred of them share one address.
    var title: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        if let session = about?.session { return "Session \(session)" }
        return address
    }
}

struct GroupItem: Decodable, Identifiable, Equatable {
    let id: String
    var name: String
    var size: Int?
}

struct Library: Decodable, Equatable {
    var proxies: [ProxyItem] = []
    var groups: [GroupItem] = []
    /// What the switch connects: yours connected or used last, else added last.
    var switchTo: Place?
    var notice: String?

    var empty: Bool { proxies.isEmpty && groups.isEmpty }

    func title(of place: Place) -> String? {
        switch place {
        case .proxy(let id): return proxies.first { $0.id == id }?.title
        case .group(let id): return groups.first { $0.id == id }?.name
        }
    }

    private enum Keys: String, CodingKey { case proxies, groups, switchTo, notice }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        proxies = try c.decodeIfPresent([ProxyItem].self, forKey: .proxies) ?? []
        groups = try c.decodeIfPresent([GroupItem].self, forKey: .groups) ?? []
        switchTo = try c.decodeIfPresent(Place.self, forKey: .switchTo)
        notice = try c.decodeIfPresent(String.self, forKey: .notice)
    }
}

/// What the last probe of the place in use found (the engine's words).
struct Health: Decodable, Equatable {
    var ok: Bool
    var latency_ms: Int?
    var exit_ip: String?
    var country_code: String?
    var country: String?
    var city: String?
    var error: String?
    var failures_in_a_row: Int?
}

struct Status: Decodable, Equatable {
    var running: Bool
    var place: Place?
    var health: Health?
}

/// The shape every error has: its name, a colon, what it means.
struct ErrorWords: Equatable {
    let name: String
    let detail: String

    init(_ words: String) {
        func upper(_ s: Substring) -> String { s.prefix(1).uppercased() + s.dropFirst() }
        if let at = words.range(of: ": ") {
            name = upper(words[..<at.lowerBound])
            detail = upper(words[at.upperBound...])
        } else {
            name = ""
            detail = upper(words[...])
        }
    }

    /// The whole of it, on one line.
    var line: String { name.isEmpty ? detail : "\(name): \(detail)" }
}

/// What the app tells its tunnel. The tunnel reads these when it starts.
enum TunnelKey {
    static let place = "place"
    static let killSwitch = "killSwitch"
    static let routeMode = "routeMode"
    static let routeSites = "routeSites"
    static let firstHop = "firstHop"
}
