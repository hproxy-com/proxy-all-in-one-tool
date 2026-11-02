import Foundation
import NetworkExtension

/// The connection, in the process iOS gives a tunnel: the engine's relay and its
/// tunnel (the same Rust as on Android), with packets crossing to it one by one
/// through `packetFlow`, the public way in. Nothing here decides anything about a
/// proxy: the engine tests it before anything points at it, and this only starts
/// after that passed.
final class PacketTunnelProvider: NEPacketTunnelProvider {
    /// While the kill switch is off and the proxy stopped, nothing is routed here:
    /// apps use the phone's own internet until it answers.
    private var aside = false
    private var killSwitch = true
    private var watching = false
    /// The tunnel's addresses and routes, from the engine: the same as on Android.
    private var network: [String: Any] = [:]

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        let settings = (protocolConfiguration as? NETunnelProviderProtocol)?.providerConfiguration ?? [:]
        Task {
            do {
                try await Engine.start(inTunnel: true)
                killSwitch = settings[TunnelKey.killSwitch] as? Bool ?? true
                network = try await Engine.call("vpnArgs") as? [String: Any] ?? [:]
                try await Engine.call("routing", [
                    "mode": settings[TunnelKey.routeMode] as? String ?? "all",
                    "sites": settings[TunnelKey.routeSites] as? String ?? "",
                    "firstHop": settings[TunnelKey.firstHop] as? String ?? "",
                ])
                let text = settings[TunnelKey.place] as? String ?? ""
                let place = try JSONSerialization.jsonObject(with: Data(text.utf8))
                // Traffic got through before this answers (the engine's first test).
                try await Engine.call("connect", ["place": place])
                try await apply(routed: true)
                try startPackets()
                Engine.lastError = nil
                watch()
                completionHandler(nil)
            } catch {
                Engine.lastError = error.localizedDescription
                completionHandler(error)
            }
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        watching = false
        hproxy_tunnel_stop()
        Task {
            _ = try? await Engine.call("disconnect")
            completionHandler()
        }
    }

    /// The app's questions: `{"method": ..., "args": {...}}`, the engine's answer back.
    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        Task {
            var answer: [String: Any]
            do {
                let message = try JSONSerialization.jsonObject(with: messageData) as? [String: Any] ?? [:]
                let method = message["method"] as? String ?? ""
                let value = try await Engine.call(method, message["args"] as? [String: Any] ?? [:])
                answer = ["ok": true, "value": value]
            } catch {
                answer = ["ok": false, "error": error.localizedDescription]
            }
            completionHandler?(try? JSONSerialization.data(withJSONObject: answer))
        }
    }

    /// The tunnel's settings. Routed: the internet comes here, DNS included, and the
    /// home network stays outside. Not routed: the tunnel stays up and idle, and apps
    /// use the phone's own internet.
    private func apply(routed: Bool) async throws {
        let addresses = (network["addresses"] as? [String] ?? []).compactMap(Route.init)
        let routes = (network["routes"] as? [String] ?? []).compactMap(Route.init)
        guard let own4 = addresses.first(where: { !$0.isV6 }), let own6 = addresses.first(where: { $0.isV6 }) else {
            throw EngineError(message: "The tunnel has no address")
        }
        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "127.0.0.1")
        settings.mtu = network["mtu"] as? NSNumber
        let v4 = NEIPv4Settings(addresses: [own4.address], subnetMasks: [own4.mask])
        let v6 = NEIPv6Settings(addresses: [own6.address], networkPrefixLengths: [NSNumber(value: own6.length)])
        if routed {
            // IPv6 too: an address family left out would go out with the real address.
            v4.includedRoutes = routes.filter { !$0.isV6 }.map {
                NEIPv4Route(destinationAddress: $0.address, subnetMask: $0.mask)
            }
            v6.includedRoutes = routes.filter(\.isV6).map {
                NEIPv6Route(destinationAddress: $0.address, networkPrefixLength: NSNumber(value: $0.length))
            }
            let dns = NEDNSSettings(servers: [network["dns"] as? String ?? ""])
            dns.matchDomains = [""]
            settings.dnsSettings = dns
        }
        settings.ipv4Settings = v4
        settings.ipv6Settings = v6
        try await setTunnelNetworkSettings(settings)
    }

    private func startPackets() throws {
        let context = Unmanaged.passUnretained(self).toOpaque()
        let write: hproxy_write = { context, packet, length in
            guard let context, let packet else { return }
            let provider = Unmanaged<PacketTunnelProvider>.fromOpaque(context).takeUnretainedValue()
            let data = Data(bytes: packet, count: length)
            let family = (data.first ?? 0) >> 4 == 6 ? AF_INET6 : AF_INET
            provider.packetFlow.writePackets([data], withProtocols: [NSNumber(value: family)])
        }
        try Engine.read(hproxy_tunnel_start(write, context, true))
        readPackets()
    }

    private func readPackets() {
        packetFlow.readPackets { [weak self] packets, _ in
            for packet in packets {
                packet.withUnsafeBytes { bytes in
                    hproxy_tunnel_packet(bytes.bindMemory(to: UInt8.self).baseAddress, packet.count)
                }
            }
            self?.readPackets()
        }
    }

    /// What the engine says on its own. The kill switch off: out of the way after
    /// two probes failed, back the moment one answers. On, apps wait for the proxy.
    private func watch() {
        watching = true
        Task {
            while watching {
                guard let event = await Engine.poll(milliseconds: 2000),
                      event["type"] as? String == "health",
                      !killSwitch else { continue }
                let ok = event["ok"] as? Bool ?? true
                let failures = event["failures_in_a_row"] as? Int ?? 0
                if !ok && failures >= 2 && !aside {
                    aside = true
                    try? await apply(routed: false)
                } else if ok && aside {
                    aside = false
                    try? await apply(routed: true)
                }
            }
        }
    }
}
