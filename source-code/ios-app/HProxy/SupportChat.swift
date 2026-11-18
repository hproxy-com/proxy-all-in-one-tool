import Foundation

/// The Help tab: talking to HProxy support, as on the phone app (SupportChat.kt). The engine
/// holds the socket to chat.hproxy.com (proxy-engine/hproxy-mobile/src/chat.rs, which names
/// this app "HProxy iPhone") and tells what happens through "chat" events; this keeps the
/// thread for the screen. The chat shows "HProxy support" and its people, nothing else.
@MainActor
final class SupportChat: ObservableObject {
    enum Sent { case sending, delivered, read, failed }

    struct Message: Identifiable, Equatable {
        /// The server's id, or (until it answered) the app's own.
        var id: String
        let mine: Bool
        let body: String
        let at: Date
        var sent: Sent
        /// Who answered, when the chat names a person.
        let by: String?
    }

    enum Link { case closed, opening, open, down }

    @Published private(set) var messages: [Message] = []
    @Published private(set) var link = Link.closed
    /// Someone from support is there now.
    @Published private(set) var online = false
    @Published private(set) var typing = false
    /// "1-3 minutes", as the chat says it.
    @Published private(set) var replyTime: String?
    /// What the box holds: "Idea: " after Settings' "Send an idea".
    @Published var draft = ""

    private var conversation: String?
    private var counter = 0

    /// The two ways people start here. The phone app's third, "I need a country", asks for
    /// proxies to buy, which the iPhone app never leads to (guideline 3.1.1).
    static let starters: [(word: String, start: String)] = [
        ("I have an idea", "Idea: "),
        ("Something broke", "Something broke: "),
    ]

    /// A starter with nothing added: sent alone it leaves support guessing.
    static func bare(_ text: String) -> Bool {
        starters.contains { $0.start.trimmingCharacters(in: .whitespaces) == text.trimmingCharacters(in: .whitespaces) }
    }

    /// The visitor token the chat gave last time, so the person's own thread comes back.
    private var token: String? {
        get { UserDefaults.standard.string(forKey: "chatToken") }
        set { UserDefaults.standard.set(newValue, forKey: "chatToken") }
    }

    /// Where this copy came from, for support: TestFlight or the App Store.
    private var store: String {
        Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" ? "testflight" : "app-store"
    }

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    /// Open the chat (Help showing). Support sees where it was written from: this app, its
    /// store and its version.
    func open() {
        guard link != .open, link != .opening else { return }
        link = .opening
        var args: [String: Any] = ["store": store, "version": version]
        if let token { args["token"] = token }
        Task {
            do {
                try await Engine.call("chatOpen", args)
            } catch {
                link = .down
            }
        }
    }

    /// Send what the box holds. It shows at once, "Sending" until the chat has it.
    @discardableResult
    func send(_ text: String) -> Bool {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, !Self.bare(body) else { return false }
        let id = "app-\(Int(Date().timeIntervalSince1970 * 1000))-\(counter)"
        counter += 1
        messages.append(Message(id: id, mine: true, body: body, at: Date(), sent: .sending, by: nil))
        draft = ""
        Task {
            do {
                try await Engine.call("chatSend", ["id": id, "body": body])
            } catch {
                mark(id) { $0.sent = .failed }
                link = .down
                open()
            }
        }
        return true
    }

    /// Send a message again that did not go.
    func retry(_ message: Message) {
        messages.removeAll { $0.id == message.id }
        send(message.body)
    }

    /// The person read the thread: support sees it.
    func read() {
        guard let conversation else { return }
        Task { _ = try? await Engine.call("chatRead", ["conversationId": conversation]) }
    }

    private func mark(_ id: String, _ change: (inout Message) -> Void) {
        guard let n = messages.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[n])
    }

    private func message(_ o: [String: Any]) -> Message? {
        guard let body = o["body"] as? String, !body.isEmpty, o["is_internal"] as? Bool != true else { return nil }
        let mine = o["author_type"] as? String == "visitor"
        let read = o["read_by_agent_at"] as? String != nil
        let named = (o["author_name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return Message(
            id: o["id"] as? String ?? UUID().uuidString,
            mine: mine,
            body: body,
            at: Self.time(o["created_at"] as? String),
            sent: mine && read ? .read : .delivered,
            by: mine ? nil : named
        )
    }

    /// "2026-10-11T18:42:55.399470Z", to the second.
    private static func time(_ s: String?) -> Date {
        guard let s, s.count >= 19 else { return Date() }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return f.date(from: String(s.prefix(19))) ?? Date()
    }

    #if DEBUG
    /// The store's pictures (AppModel.showDemo): an example thread about the app itself.
    /// Never in a release build.
    func showDemo() {
        link = .open
        online = true
        // Minutes before the 9:41 the pictures' status bar shows (scripts/pictures.sh).
        func at(_ minute: Int) -> Date {
            Calendar.current.date(bySettingHour: 9, minute: minute, second: 0, of: Date()) ?? Date()
        }
        messages = [
            Message(id: "d1", mine: true, body: "Hi, my proxy shows Timed out since this morning. What can I do?", at: at(34), sent: .read, by: nil),
            Message(id: "d2", mine: false, body: "Hi! Timed out means the proxy itself stopped answering. Open the Checker, paste it in and check it: it tells you exactly why it fails.", at: at(35), sent: .delivered, by: nil),
            Message(id: "d3", mine: true, body: "Checked it, it works again now. Thanks!", at: at(39), sent: .read, by: nil),
        ]
    }
    #endif

    /// One "chat" event from the engine.
    func handle(_ e: [String: Any]) {
        switch e["kind"] as? String {
        case "ready":
            link = .open
            if let t = e["token"] as? String, !t.isEmpty { token = t }
            conversation = (e["conversation"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            online = e["online"] as? Bool ?? false
            replyTime = (e["replyTime"] as? String).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        case "history":
            let old = ((e["messages"] as? [[String: Any]]) ?? []).compactMap(message)
            // Messages still on their way stay after the thread as the chat keeps it.
            let pending = messages.filter { $0.sent == .sending || $0.sent == .failed }
            messages = old + pending.filter { p in !old.contains { $0.mine && $0.body == p.body } }
        case "message":
            guard let o = e["message"] as? [String: Any], let m = message(o) else { return }
            if !messages.contains(where: { $0.id == m.id }) { messages.append(m) }
            if !m.mine { typing = false }
            if let c = o["conversation_id"] as? String, !c.isEmpty { conversation = c }
        case "ack":
            guard let a = e["ack"] as? [String: Any], let id = a["id"] as? String else { return }
            let server = (a["server_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            if let c = a["conversation_id"] as? String, !c.isEmpty { conversation = c }
            switch a["state"] as? String {
            case "delivered": mark(id) { $0.id = server ?? $0.id; $0.sent = .delivered }
            case "read": mark(server ?? id) { $0.sent = .read }
            default: break
            }
        case "conversation":
            if let c = (e["conversation"] as? [String: Any])?["id"] as? String, !c.isEmpty { conversation = c }
        case "typing":
            typing = e["on"] as? Bool ?? false
        case "online":
            online = e["online"] as? Bool ?? false
        case "deleted":
            if let id = e["id"] as? String { messages.removeAll { $0.id == id } }
        case "down":
            if link != .closed { link = .down }
            typing = false
        case "error":
            if let id = e["id"] as? String, id.hasPrefix("app-") { mark(id) { $0.sent = .failed } }
        default:
            break
        }
    }
}
