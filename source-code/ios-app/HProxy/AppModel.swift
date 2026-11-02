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

    private let tunnel = TunnelControl()
    private var going: Place?
    private var watching: Task<Void, Never>?

    /// The proxy stopped answering: two probes in a row, as on every other app.
    var stopped: Bool { phase == .on && (health?.failures_in_a_row ?? 0) >= 2 }

    init() {
        Task {
            do {
                try await Engine.start(inTunnel: false)
            } catch {
                note = error.localizedDescription
            }
            if let value = await ask("library") {
                take(value)
            }
            tunnel.onChange = { [weak self] status in self?.follow(status) }
            await tunnel.load()
        }
    }

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
        }
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
