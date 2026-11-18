import AppIntents
import NetworkExtension

// On and off without opening the app (the phone app's Quick Settings tile, vpn/QuickTile.kt):
// "Connect HProxy" and "Disconnect HProxy" for Siri, Spotlight, the Shortcuts app and the
// Action button, and for Control Center through iOS's own Shortcut control. They run in the
// app's process (launched in the background), on the VPN configuration the app saved at its
// last connect: the same place and choices.

/// Connect to the proxy used last.
struct ConnectIntent: AppIntent {
    static var title: LocalizedStringResource = "Connect HProxy"
    static var description = IntentDescription("Connects through the proxy you used last, with your settings.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let manager = try await NETunnelProviderManager.loadAllFromPreferences().first else {
            return .result(dialog: "Connect once in HProxy first. Then this connects you right away.")
        }
        manager.isEnabled = true
        // Settings' "Stay connected", which the last stop switched off.
        manager.isOnDemandEnabled = UserDefaults.standard.bool(forKey: "stayConnected")
        try await manager.saveToPreferences()
        try await manager.loadFromPreferences()
        try manager.connection.startVPNTunnel()
        return .result(dialog: "HProxy is connecting.")
    }
}

/// Disconnect. "Stay connected" is switched off first, or iOS would connect again at once.
struct DisconnectIntent: AppIntent {
    static var title: LocalizedStringResource = "Disconnect HProxy"
    static var description = IntentDescription("Disconnects HProxy until you connect again.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let manager = try await NETunnelProviderManager.loadAllFromPreferences().first else {
            return .result(dialog: "HProxy is not connected.")
        }
        if manager.isOnDemandEnabled {
            manager.isOnDemandEnabled = false
            try await manager.saveToPreferences()
        }
        manager.connection.stopVPNTunnel()
        return .result(dialog: "HProxy is off.")
    }
}

/// What Siri and Spotlight offer by themselves.
struct HProxyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ConnectIntent(), phrases: ["Connect \(.applicationName)", "Turn on \(.applicationName)"])
        AppShortcut(intent: DisconnectIntent(), phrases: ["Disconnect \(.applicationName)", "Turn off \(.applicationName)"])
    }
}
