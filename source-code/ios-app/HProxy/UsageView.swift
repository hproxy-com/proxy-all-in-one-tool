import SwiftUI

/// Usage counts, as on the phone app (state/Usage.kt, ui/settings/UsagePage.kt): a switch in
/// Settings and nowhere else, with the last report exactly as it went. Nothing is counted,
/// written or sent before it is on; off deletes this copy's random number and its counts. The
/// engine counts what happens in it (hproxy-api, usage.rs); the app tells it only an opening.
@MainActor
final class UsageCounts: ObservableObject {
    @Published private(set) var on = false
    /// The last report as it was sent, or nil before the first.
    @Published private(set) var last: String?

    /// What a report holds, one line each.
    static let holds = [
        "How often HProxy was opened",
        "How many connections worked, and why the others failed",
        "How many checks ran, and how long the lists were, roughly",
        "How many proxies and groups you keep, roughly",
        "Which features you used",
        "How often a part of the app crashed",
    ]
    static let never = "Never a proxy, a login, a site you visit, a name, a note or anything else you type."

    func load() async {
        if let view = try? await Engine.call("usage") as? [String: Any] { read(view) }
    }

    func answer(_ yes: Bool) async {
        if let view = try? await Engine.call("usageAnswer", ["yes": yes]) as? [String: Any] { read(view) }
    }

    private func read(_ view: [String: Any]) {
        on = view["answer"] as? String == "yes"
        if let report = view["last"], !(report is NSNull),
           let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            last = String(decoding: data, as: UTF8.self)
        } else {
            last = nil
        }
    }

    /// The app opened, and the finished days that wait go, once each. The engine does
    /// nothing with either before the switch is on.
    static func opened() async {
        _ = try? await Engine.call("usageCount", ["event": ["kind": "opened"]])
        _ = try? await Engine.call("usageSend")
    }
}

/// Settings, "Usage counts": the switch, what a report holds, and the last one as it went.
struct UsageView: View {
    @StateObject private var usage = UsageCounts()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Once a day, a few counts about the day before, so we fix what fails most and build what you use.")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(C.ink2)
                    .padding(.bottom, 14)
                Toggle("Send once a day", isOn: Binding(
                    get: { usage.on },
                    set: { yes in Task { await usage.answer(yes) } }
                ))
                .toggleStyle(CutToggle())
                .font(.system(size: 16.5, weight: .bold))
                .padding(.vertical, 8)
                Text("\(UsageCounts.never) Off deletes this copy's random number and its counts.")
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundColor(C.ink2)
                    .padding(.bottom, 18)

                heading("A report holds")
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(UsageCounts.holds, id: \.self) { line in
                        Text(line).font(.system(size: 14, weight: .medium)).foregroundColor(C.ink)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .overlay(Cut(big: 14, small: 5).stroke(C.line, lineWidth: 1))
                .padding(.bottom, 18)

                heading("The last one sent")
                Text(usage.last ?? "Nothing sent yet. The first report goes the day after you switch it on.")
                    .font(.system(size: 12.5, weight: .medium, design: .monospaced))
                    .foregroundColor(C.ink2)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .overlay(Cut(big: 14, small: 5).stroke(C.line, lineWidth: 1))
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .background(C.bg.ignoresSafeArea())
        .navigationTitle("Usage counts")
        .task { await usage.load() }
    }

    private func heading(_ words: String) -> some View {
        Text(words)
            .font(.system(size: 13, weight: .bold))
            .foregroundColor(C.ink3)
            .padding(.bottom, 8)
    }
}
