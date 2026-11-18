import NetworkExtension
import SwiftUI

/// The app's state: the library and the connection. The screens draw from it.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case off, connecting, on, leaving
    }

    @Published var library = Library()
    @Published var phase = Phase.off
    @Published var health: Health?
    /// The engine's words for the last connect that did not go through.
    @Published var failure: String?
    /// Anything else that went wrong, shown in red until it is pressed away.
    @Published var note: String?
    /// A short word that something worked ("3 working proxies copied"), gone by itself.
    @Published var toast: String?

    /// The Checker's runs and the support chat. The engine's events reach them through `pump`.
    let checker = CheckerModel()
    let chat = SupportChat()

    private let tunnel = TunnelControl()
    private var going: Place?
    private var watching: Task<Void, Never>?
    private var events: Task<Void, Never>?
    private var toastGone: Task<Void, Never>?

    /// The proxy stopped answering: two probes in a row, as on every other app.
    var stopped: Bool { phase == .on && (health?.failures_in_a_row ?? 0) >= 2 }

    init() {
        #if DEBUG
        if let demo = UserDefaults.standard.string(forKey: "demo") {
            showDemo(demo)
            return
        }
        #endif
        Task {
            do {
                try await Engine.start(inTunnel: false)
            } catch {
                note = error.localizedDescription
            }
            pump()
            // An opening, and yesterday's counts on their way: only after the person's yes.
            Task { await UsageCounts.opened() }
            if let value = await ask("library") {
                take(value)
            }
            tunnel.onChange = { [weak self] status in self?.follow(status) }
            await tunnel.load()
        }
    }

    #if DEBUG
    /// The store's pictures (`-demo on`, `off` or `stopped`, scripts/pictures.sh): a
    /// connection on example addresses, since a tunnel cannot run on the Simulator. Never
    /// in a release build.
    private func showDemo(_ state: String) {
        // Last days, so My proxies shows both kinds: one soon (red, a reminder is due) and
        // one weeks away.
        func inDays(_ n: Int) -> String {
            Reminders.written(Calendar.current.date(byAdding: .day, value: n, to: Date()) ?? Date())
        }
        library.proxies = [
            ProxyItem(id: "a", name: "New York residential", address: "203.0.113.24:8080", scheme: "http", expires: inDays(26)),
            ProxyItem(id: "b", address: "198.51.100.7:1080", scheme: "socks5"),
            ProxyItem(id: "c", name: "Berlin mobile", address: "192.0.2.61:8000", scheme: "http"),
        ]
        library.groups = [GroupItem(id: "g", name: "Rotating sessions", size: 100, expires: inDays(3))]
        library.switchTo = .proxy("a")
        checker.showDemo()
        chat.showDemo()
        guard state != "off" else { return }
        phase = .on
        let stopped = state == "stopped"
        health = Health(
            ok: !stopped,
            latency_ms: 84,
            exit_ip: "203.0.113.24",
            country_code: "US",
            country: "United States",
            city: "New York",
            error: stopped ? "timed out: the proxy did not answer in time" : nil,
            failures_in_a_row: stopped ? 2 : 0
        )
    }
    #endif

    /// One call to the engine. What it refuses is said in red.
    private func ask(_ method: String, _ args: [String: Any] = [:]) async -> Any? {
        do {
            return try await Engine.call(method, args)
        } catch {
            note = error.localizedDescription
            return nil
        }
    }

    private func take(_ value: Any) {
        if let library = try? Engine.decode(Library.self, from: value) {
            self.library = library
            // Its last days call for reminders (Reminders.swift), planned again on every change.
            Task { await Reminders.plan(library) }
        }
    }

    // MARK: A saved proxy's or group's name, last day and note

    func rename(proxy id: String, to name: String) async {
        if let value = await ask("rename", ["id": id, "name": name]) { take(value) }
    }

    func rename(group id: String, to name: String) async {
        if let value = await ask("renameGroup", ["id": id, "name": name]) { take(value) }
    }

    /// A last day (`YYYY-MM-DD`, "" takes it away) or a note; a field left out stays. A
    /// first last day asks for notifications, since a last day is a reminder.
    func describe(proxy id: String, expires: String? = nil, note: String? = nil) async {
        if let value = await ask("describe", ["ids": [id], "details": details(expires, note)]) { take(value) }
        if expires?.isEmpty == false { await remindersAllowed() }
    }

    func describe(group id: String, expires: String? = nil, note: String? = nil) async {
        if let value = await ask("describeGroup", ["id": id, "details": details(expires, note)]) { take(value) }
        if expires?.isEmpty == false { await remindersAllowed() }
    }

    private func details(_ expires: String?, _ note: String?) -> [String: Any] {
        var details: [String: Any] = [:]
        if let expires { details["expires"] = expires }
        if let note { details["note"] = note }
        return details
    }

    private func remindersAllowed() async {
        await Reminders.ask()
        await Reminders.plan(library)
    }

    /// A saved proxy's whole line, login and all, for Copy.
    func line(of place: Place) async -> String? {
        (await ask("secret", ["place": place.json]) as? [String: Any])?["line"] as? String
    }

    /// What the engine does on its own, as it happens: the Checker's answers turning its
    /// cards over (`check`, `checkGeo`, `checkDone`) and the support chat (`chat`). One wait
    /// at a time, off the main thread.
    private func pump() {
        events?.cancel()
        events = Task { [weak self] in
            while !Task.isCancelled {
                guard let event = await Engine.poll(milliseconds: 1000) else { continue }
                if event["type"] as? String == "chat" {
                    self?.chat.handle(event)
                } else {
                    self?.checker.handle(event)
                }
            }
        }
    }

    /// Say that something worked, for a moment.
    func say(_ words: String) {
        toast = words
        toastGone?.cancel()
        toastGone = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    /// Save lines into My proxies, several as one group. False when the engine refused
    /// (its words are in red then).
    @discardableResult
    func addLines(_ text: String, asGroup: Bool) async -> Bool {
        guard let answer = await ask("add", ["text": text, "asGroup": asGroup]) as? [String: Any] else { return false }
        if let library = answer["library"] { take(library) }
        return true
    }

    /// A proxy from the Checker, used on this phone: saved into My proxies, then connected
    /// with the choices Settings has (or switched to, when connected already).
    func use(line: String) async {
        guard let answer = await ask("add", ["text": line, "asGroup": false]) as? [String: Any] else { return }
        if let library = answer["library"] { take(library) }
        guard let added = answer["added"] as? [String: Any], let value = added["place"],
              let place = try? Engine.decode(Place.self, from: value) else {
            note = "not added: that proxy could not be saved"
            return
        }
        connect(place, .current)
    }

    // MARK: Your proxies

    /// How many proxies a paste holds.
    func count(in text: String) async -> Int {
        let review = try? await Engine.call("review", ["text": text])
        return (review as? [String: Any])?["proxies"] as? Int ?? 0
    }

    func add(_ text: String) async {
        let answer = await ask("add", ["text": text, "asGroup": false]) as? [String: Any]
        if let library = answer?["library"] {
            take(library)
        }
    }

    func remove(_ proxy: ProxyItem) async {
        if let value = await ask("forget", ["id": proxy.id]) {
            take(value)
        }
    }

    func removeGroup(_ group: GroupItem) async {
        if let value = await ask("forgetGroup", ["id": group.id]) {
            take(value)
        }
    }

    // MARK: The connection

    func toggle(_ choices: TunnelChoices) {
        switch phase {
        case .off:
            if let place = library.switchTo {
                connect(place, choices)
            }
        case .connecting where tunnel.status == .disconnected || tunnel.status == .invalid:
            // Still being set up, or iOS is asking for its OK: nothing runs to stop yet.
            break
        case .on, .connecting:
            phase = .leaving
            tunnel.stop()
        case .leaving:
            break
        }
    }

    func connect(_ place: Place, _ choices: TunnelChoices) {
        switch phase {
        case .off:
            failure = nil
            going = place
            phase = .connecting
            Task {
                do {
                    try await tunnel.start(place: place, choices: choices)
                } catch {
                    failure = words(for: error)
                    going = nil
                    phase = .off
                }
            }
        case .on:
            switchTo(place)
        case .connecting, .leaving:
            break
        }
    }

    /// The refusal iOS gives when its question is answered with Don't Allow, in the
    /// shape every error has.
    private func words(for error: Error) -> String {
        let error = error as NSError
        if error.domain == NEVPNErrorDomain, error.code == NEVPNError.Code.configurationReadWriteFailed.rawValue {
            return "not allowed: HProxy needs your OK to add its VPN configuration"
        }
        return error.localizedDescription
    }

    /// Connected already: the engine tests the new place first, and the one in use
    /// goes on if it fails.
    private func switchTo(_ place: Place) {
        Task {
            do {
                try await tunnel.ask("connect", ["place": place.json])
                await used(place)
                await poll()
            } catch {
                note = error.localizedDescription
            }
        }
    }

    /// The tunnel only reads the library: the app notes what was used.
    private func used(_ place: Place) async {
        if let value = await ask("used", ["place": place.json]) {
            take(value)
        }
    }

    private func follow(_ status: NEVPNStatus) {
        switch status {
        case .connecting, .reasserting:
            phase = .connecting
        case .connected:
            phase = .on
            if let place = going {
                going = nil
                Task { await used(place) }
            }
            watch()
        case .disconnecting:
            phase = .leaving
        default:
            phase = .off
            health = nil
            going = nil
            watching?.cancel()
            if let words = Engine.lastError {
                failure = words
                Engine.lastError = nil
            }
        }
    }

    /// What the tunnel's probes found, while connected.
    private func watch() {
        watching?.cancel()
        watching = Task {
            while !Task.isCancelled {
                await poll()
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    private func poll() async {
        guard let value = try? await tunnel.ask("status"),
              let status = try? Engine.decode(Status.self, from: value) else { return }
        health = status.health
    }
}
