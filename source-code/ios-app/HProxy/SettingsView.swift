import SwiftUI

/// Settings. The tunnel reads them when it starts, so they count from the next connection.
struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("killSwitch") private var killSwitch = true
    @AppStorage("routeMode") private var routeMode = "all"
    @AppStorage("routeSites") private var routeSites = ""
    @AppStorage("firstHop") private var firstHop = ""

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    var body: some View {
        NavigationStack {
            Form {
                if model.phase != .off {
                    Text("Changes here count from your next connection.")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(C.ink2)
                        .listRowBackground(C.s1)
                }

                Section {
                    Toggle("Kill switch", isOn: $killSwitch).tint(C.blue)
                } footer: {
                    Text(killSwitch
                        ? "If your proxy stops answering, apps wait for it."
                        : "If your proxy stops answering, apps use your own internet until it answers.")
                }
                .listRowBackground(C.s1)

                Section {
                    Picker("Sites", selection: $routeMode) {
                        Text("All sites").tag("all")
                        Text("All except these").tag("except")
                        Text("Only these").tag("only")
                    }
                    if routeMode != "all" {
                        TextField("example.com, one on each line", text: $routeSites, axis: .vertical)
                            .lineLimit(3...8)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                    }
                } footer: {
                    Text("Which sites use the proxy. A site that skips it leaves on your own address, also with the kill switch on.")
                }
                .listRowBackground(C.s1)

                Section {
                    Picker("Two proxies in a row", selection: $firstHop) {
                        Text("Off").tag("")
                        ForEach(model.library.proxies) { proxy in
                            Text(proxy.title).tag(proxy.id)
                        }
                    }
                } footer: {
                    Text("Your connection goes through this proxy first. The one you connect to only sees its address.")
                }
                .listRowBackground(C.s1)

                Section {
                    Link("Privacy policy", destination: URL(string: "https://hproxy.com/privacy")!)
                    Link("Support", destination: URL(string: "https://hproxy.com/contact")!)
                    LabeledContent("Version", value: version)
                }
                .listRowBackground(C.s1)
            }
            .scrollContentBackground(.hidden)
            .background(C.bg.ignoresSafeArea())
            .navigationTitle("Settings")
        }
        .onChange(of: model.library.proxies) { proxies in
            // A proxy that is gone can no longer go first.
            if !firstHop.isEmpty, !proxies.contains(where: { $0.id == firstHop }) {
                firstHop = ""
            }
        }
    }
}
