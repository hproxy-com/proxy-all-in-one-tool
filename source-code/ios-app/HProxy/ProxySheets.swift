import SwiftUI

/// A saved proxy, opened (the phone app's ProxySheet.kt): its name, its plan's last day (a
/// reminder three days before and on the day), a note, what it is, and use it, copy it or
/// remove it.
struct ProxySheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let id: String

    @State private var name = ""
    @State private var note = ""
    @State private var hasLastDay = false
    @State private var lastDay = Date()
    @State private var removing = false

    private var proxy: ProxyItem? { model.library.proxies.first { $0.id == id } }

    var body: some View {
        NavigationStack {
            Form {
                if let p = proxy {
                    Section {
                        TextField("Give it a name, like Shop account", text: $name)
                            .submitLabel(.done)
                            .onSubmit { saveName(p) }
                    } header: { Text("Name") }

                    LastDaySection(hasLastDay: $hasLastDay, lastDay: $lastDay)

                    Section {
                        TextField("Where it is from, what it is for", text: $note, axis: .vertical)
                            .lineLimit(1...4)
                    } header: { Text("Note") }

                    Section {
                        LabeledContent("Proxy", value: p.address)
                        LabeledContent("Protocol", value: p.scheme?.uppercased() ?? "HTTP or SOCKS5")
                        LabeledContent("Speed", value: speed(p))
                        LabeledContent("Comes out as", value: p.last?.exitIp ?? "Known once it answered")
                    }

                    Section {
                        Button("Connect") {
                            model.connect(.proxy(p.id), .current)
                            dismiss()
                        }
                        Button("Copy the proxy") {
                            Task {
                                guard let line = await model.line(of: .proxy(p.id)) else { return }
                                UIPasteboard.general.string = line
                                model.say("\(p.title) copied")
                            }
                        }
                        Button("Remove from My proxies", role: .destructive) { removing = true }
                    }
                } else {
                    Text("This proxy is not here any more.").foregroundColor(C.ink2)
                }
            }
            .scrollContentBackground(.hidden)
            .background(C.bg.ignoresSafeArea())
            .navigationTitle(proxy?.title ?? "Proxy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Remove this proxy from My proxies?", isPresented: $removing, titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    guard let p = proxy else { return }
                    Task {
                        await model.remove(p)
                        dismiss()
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            guard let p = proxy else { return }
            name = p.name ?? ""
            note = p.note ?? ""
            hasLastDay = p.expires != nil
            lastDay = Reminders.date(p.expires) ?? Date()
        }
        .onChange(of: hasLastDay) { _ in saveLastDay() }
        .onChange(of: lastDay) { _ in saveLastDay() }
        .onDisappear {
            guard let p = proxy else { return }
            saveName(p)
            if note != (p.note ?? "") { Task { await model.describe(proxy: p.id, note: note) } }
        }
    }

    private func saveName(_ p: ProxyItem) {
        guard name != (p.name ?? "") else { return }
        Task { await model.rename(proxy: p.id, to: name) }
    }

    /// Kept the moment it is picked; "" takes it away. Nothing when it did not change (the
    /// sheet opening sets the same day).
    private func saveLastDay() {
        guard let p = proxy else { return }
        let written = hasLastDay ? Reminders.written(lastDay) : ""
        guard written != (p.expires ?? "") else { return }
        Task { await model.describe(proxy: p.id, expires: written) }
    }

    private func speed(_ p: ProxyItem) -> String {
        guard let last = p.last else { return "Not checked yet" }
        guard last.ok == true else { return "No answer" }
        return last.latencyMs.map(speedWords) ?? "Answered"
    }
}

/// A saved group, opened: its name, its plan's last day and a note, connect or remove it.
struct GroupSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let id: String

    @State private var name = ""
    @State private var note = ""
    @State private var hasLastDay = false
    @State private var lastDay = Date()
    @State private var removing = false

    private var group: GroupItem? { model.library.groups.first { $0.id == id } }

    var body: some View {
        NavigationStack {
            Form {
                if let g = group {
                    Section {
                        TextField("Give it a name", text: $name)
                            .submitLabel(.done)
                            .onSubmit { saveName(g) }
                    } header: { Text("Name") }

                    LastDaySection(hasLastDay: $hasLastDay, lastDay: $lastDay)

                    Section {
                        TextField("Where it is from, what it is for", text: $note, axis: .vertical)
                            .lineLimit(1...4)
                    } header: { Text("Note") }

                    Section {
                        LabeledContent("Proxies", value: g.size.map { "\($0)" } ?? "Several")
                    }

                    Section {
                        Button("Connect") {
                            model.connect(.group(g.id), .current)
                            dismiss()
                        }
                        Button("Remove the group", role: .destructive) { removing = true }
                    }
                } else {
                    Text("This group is not here any more.").foregroundColor(C.ink2)
                }
            }
            .scrollContentBackground(.hidden)
            .background(C.bg.ignoresSafeArea())
            .navigationTitle(group?.name ?? "Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Remove this group and its proxies?", isPresented: $removing, titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    guard let g = group else { return }
                    Task {
                        await model.removeGroup(g)
                        dismiss()
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            guard let g = group else { return }
            name = g.name
            note = g.note ?? ""
            hasLastDay = g.expires != nil
            lastDay = Reminders.date(g.expires) ?? Date()
        }
        .onChange(of: hasLastDay) { _ in saveLastDay() }
        .onChange(of: lastDay) { _ in saveLastDay() }
        .onDisappear {
            guard let g = group else { return }
            saveName(g)
            if note != (g.note ?? "") { Task { await model.describe(group: g.id, note: note) } }
        }
    }

    private func saveName(_ g: GroupItem) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != g.name else { return }
        Task { await model.rename(group: g.id, to: trimmed) }
    }

    private func saveLastDay() {
        guard let g = group else { return }
        let written = hasLastDay ? Reminders.written(lastDay) : ""
        guard written != (g.expires ?? "") else { return }
        Task { await model.describe(group: g.id, expires: written) }
    }
}

/// The plan's last day: a switch, and the day under it while on.
private struct LastDaySection: View {
    @Binding var hasLastDay: Bool
    @Binding var lastDay: Date

    var body: some View {
        Section {
            Toggle("Last day", isOn: $hasLastDay).toggleStyle(CutToggle())
            if hasLastDay {
                DatePicker("Ends on", selection: $lastDay, displayedComponents: .date)
            }
        } footer: {
            Text("When the plan behind it ends. HProxy reminds you three days before and on the day.")
        }
    }
}
