import SwiftUI

/// Your proxies: paste them in, and each stays here until you remove it.
struct ProxiesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var adding = false

    var body: some View {
        NavigationStack {
            Group {
                if model.library.empty {
                    empty
                } else {
                    list
                }
            }
            .background(C.bg.ignoresSafeArea())
            .navigationTitle("My proxies")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        adding = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Add proxies")
                }
            }
            .sheet(isPresented: $adding) { AddView() }
        }
    }

    private var empty: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("No proxies yet")
                .font(.system(size: 22, weight: .bold))
                .foregroundColor(C.ink)
            Text("Paste your proxies here. Every shape a provider prints is read, a login too.")
                .font(.system(size: 15, weight: .medium))
                .multilineTextAlignment(.center)
                .foregroundColor(C.ink2)
            Button("Add proxies") { adding = true }
                .buttonStyle(PrimaryButton())
            Spacer()
        }
        .padding(.horizontal, 24)
    }

    private var list: some View {
        List {
            ForEach(model.library.groups) { group in
                row(group.name, group.size.map { "\($0) proxies" })
                    .swipeActions {
                        Button("Remove", role: .destructive) {
                            Task { await model.removeGroup(group) }
                        }
                    }
            }
            ForEach(model.library.proxies) { proxy in
                row(proxy.title, words(for: proxy))
                    .swipeActions {
                        Button("Remove", role: .destructive) {
                            Task { await model.remove(proxy) }
                        }
                    }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func words(for proxy: ProxyItem) -> String? {
        var parts: [String] = []
        if proxy.name != nil { parts.append(proxy.address) }
        if let scheme = proxy.scheme { parts.append(scheme.uppercased()) }
        if let ms = proxy.last?.latencyMs, proxy.last?.ok == true { parts.append("\(ms) ms") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func row(_ title: String, _ words: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 16, weight: .bold)).foregroundColor(C.ink).lineLimit(1)
            if let words {
                Text(words).font(.system(size: 13, weight: .medium)).foregroundColor(C.ink2).lineLimit(1)
            }
        }
        .padding(.vertical, 4)
        .listRowBackground(C.s1)
    }
}

/// One big box: paste one proxy or a list.
struct AddView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var found = 0

    private var nothingReadable: Bool {
        found == 0 && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var label: String {
        switch found {
        case 0: return "Add proxies"
        case 1: return "Add 1 proxy"
        default: return "Add \(found) proxies"
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 14) {
                ZStack(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("One proxy on each line, like 198.51.100.7:8080:user:pass")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(C.ink3)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 18)
                    }
                    TextEditor(text: $text)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(C.ink)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .scrollContentBackground(.hidden)
                        .padding(10)
                }
                .frame(maxHeight: 260)
                .overlay(Cut(big: 18, small: 6).stroke(C.line, lineWidth: 1))
                if nothingReadable {
                    Text("This does not read as a proxy")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(C.bad)
                }
                Button(label) {
                    Task {
                        await model.add(text)
                        dismiss()
                    }
                }
                .buttonStyle(PrimaryButton())
                .disabled(found == 0)
                Spacer()
            }
            .padding(20)
            .background(C.bg.ignoresSafeArea())
            .navigationTitle("Add proxies")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task(id: text) { found = await model.count(in: text) }
        }
        .preferredColorScheme(.dark)
    }
}
