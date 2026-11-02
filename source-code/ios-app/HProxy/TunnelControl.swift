import Foundation
import NetworkExtension

/// What a connection is started with, as Settings has it.
struct TunnelChoices {
    var killSwitch: Bool
    var routeMode: String
    var routeSites: String
    var firstHop: String
}

/// The app's side of the tunnel: iOS's VPN configuration, starting and stopping it,
/// and questions to the process that holds the connection.
@MainActor
final class TunnelControl {
    private var manager: NETunnelProviderManager?
    private var watcher: NSObjectProtocol?

    /// iOS says the state changed.
    var onChange: ((NEVPNStatus) -> Void)?

    var status: NEVPNStatus { manager?.connection.status ?? .invalid }

    /// The configuration saved earlier, if any, and from now on what happens to it.
    func load() async {
        let saved = (try? await NETunnelProviderManager.loadAllFromPreferences()) ?? []
        manager = saved.first
        watcher = NotificationCenter.default.addObserver(
            forName: .NEVPNStatusDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.onChange?(self.status)
            }
        }
        onChange?(status)
    }

    /// Start a connection to `place`. The first time, iOS asks the person to allow
    /// the VPN configuration.
    func start(place: Place, choices: TunnelChoices) async throws {
        let manager = self.manager ?? NETunnelProviderManager()
        let tunnel = NETunnelProviderProtocol()
        tunnel.providerBundleIdentifier = "com.hproxy.app.tunnel"
        tunnel.serverAddress = "HProxy"
        tunnel.disconnectOnSleep = false
        tunnel.providerConfiguration = [
            TunnelKey.place: place.text,
            TunnelKey.killSwitch: choices.killSwitch,
            TunnelKey.routeMode: choices.routeMode,
            TunnelKey.routeSites: choices.routeSites,
            TunnelKey.firstHop: choices.firstHop,
        ]
        manager.protocolConfiguration = tunnel
        manager.localizedDescription = "HProxy"
        manager.isEnabled = true
        try await manager.saveToPreferences()
        try await manager.loadFromPreferences()
        self.manager = manager
        try manager.connection.startVPNTunnel()
    }

    func stop() {
        manager?.connection.stopVPNTunnel()
    }

    /// One question to the process that holds the connection.
    @discardableResult
    func ask(_ method: String, _ args: [String: Any] = [:]) async throws -> Any {
        guard let session = manager?.connection as? NETunnelProviderSession else {
            throw EngineError(message: "Not connected")
        }
        let message = try JSONSerialization.data(withJSONObject: ["method": method, "args": args])
        let reply: Data = try await withCheckedThrowingContinuation { done in
            do {
                try session.sendProviderMessage(message) { data in
                    done.resume(returning: data ?? Data())
                }
            } catch {
                done.resume(throwing: error)
            }
        }
        guard let answer = try JSONSerialization.jsonObject(with: reply) as? [String: Any] else {
            throw EngineError(message: "The connection did not answer")
        }
        if answer["ok"] as? Bool == true {
            return answer["value"] ?? NSNull()
        }
        throw EngineError(message: (answer["error"] as? String) ?? "Something went wrong")
    }
}
