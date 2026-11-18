import SwiftUI
import UniformTypeIdentifiers

// The checker (the phone app's 5 · Flip, CheckerTab.kt). Every proxy is a card, face down:
// its flag and the end of its address. The moment its answer lands, the card turns over:
// green with its milliseconds, amber when slow, red with the reason, grey when it never
// answered. When the run is over, the cards make way for the proxies themselves, working
// ones first, each a row to use. A checker only checks: the judge is its one choice.

private let OK = Color(hex: 0x2FD07F)
private let WARN = Color(hex: 0xF5B83D)
private let BAD = Color(hex: 0xFF5A5F)
private let GONE = Color(hex: 0x3A4357)

private func colour(_ f: Face) -> Color {
    switch f {
    case .good: return OK
    case .slow: return WARN
    case .dead: return GONE
    default: return BAD
    }
}

private func ink(_ f: Face) -> Color {
    switch f {
    case .good: return Color(hex: 0x04301A)
    case .slow: return Color(hex: 0x3A2600)
    case .dead: return C.ink3
    default: return .white
    }
}

/// What a card says on its face, in two short lines.
private func faceWords(_ a: CheckAnswer) -> (String, String) {
    switch a.face {
    case .good: return ("\(a.ms ?? 0)", "ms")
    case .slow:
        if a.notes.contains("slow") { return (String(format: "%.1f", Double(a.ms ?? 0) / 1000), "s, slow") }
        if a.notes.contains("wrong_country") { return (a.cc?.uppercased() ?? "?", "exits there") }
        if a.notes.contains("tells_http_sites") { return ("http", "shows you") }
        return ("\(a.ms ?? 0)", "ms, warn")
    case .noHttps: return ("http", "only")
    case .reads: return ("unsafe", "reads it")
    case .blocked: return ("blocked", "by the site")
    case .bad:
        if a.notes.contains("not_hidden") { return ("shows", "your IP") }
        if a.notes.contains("socks4_only") { return ("socks4", "only") }
        return ("can't", "use it")
    case .dead: return ("–", "no reply")
    }
}

/// ".41": the end of an address, what a card shows face down.
private func tail(_ address: String) -> String {
    let host = address.split(separator: ":").dropLast().joined(separator: ":")
    let parts = host.split(separator: ".")
    if parts.count == 4, host.allSatisfy({ $0.isNumber || $0 == "." }) { return "." + parts[3] }
    return String(host.prefix(6))
}

private func firstUp(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

private func whenWas(_ at: Int) -> String {
    let ago = (Int(Date().timeIntervalSince1970 * 1000) - at) / 60_000
    if ago < 1 { return "Just now" }
    if ago < 60 { return "\(ago) min ago" }
    if ago < 24 * 60 { return "\(ago / 60) h ago" }
    return "\(ago / (24 * 60)) days ago"
}

struct CheckerView: View {
    @EnvironmentObject private var checker: CheckerModel
    @State private var opened: CheckCard?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Checker")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundColor(C.ink)
                Spacer()
                switch checker.run?.stage {
                case .running?:
                    LineButton(title: "Stop", icon: "stop.fill", small: true) {
                        Task { await checker.cancel() }
                    }
                case .done?:
                    Button {
                        checker.reset()
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundColor(C.blueInk)
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("A new check")
                case nil:
                    EmptyView()
                }
            }
            .padding(.horizontal, 20)
            .frame(height: 56)

            Group {
                if let run = checker.run {
                    if run.stage == .running {
                        FlipRun(run: run) { opened = $0 }
                    } else {
                        DoneList(run: run) { opened = $0 }
                    }
                } else {
                    StartPanel()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(C.bg.ignoresSafeArea())
        .task { await checker.refreshRecent() }
        .sheet(item: $opened) { card in
            CardSheet(id: card.i)
                .presentationDetents([.medium, .large])
        }
    }
}

// MARK: Before a run

private struct StartPanel: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var checker: CheckerModel
    @AppStorage("judgeKind") private var judgeKind = JudgeKind.hproxy
    @State private var typing = false
    @State private var judging = false
    @State private var importing = false
    /// Whether the clipboard holds text. Asking only that never brings up iOS's paste
    /// question; with nothing there, Apple's paste button would sit greyed out, so the card
    /// offers typing instead.
    @State private var clipHasText = UIPasteboard.general.hasStrings

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("See which of your proxies work.")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(C.ink2)
                pasteCard.padding(.top, 16)
                judgeRow.padding(.top, 10)
                label("Or add them another way").padding(.top, 18).padding(.bottom, 8)
                HStack(spacing: 8) {
                    way("doc.text", "File") { importing = true }
                    way("keyboard", "Type") { typing = true }
                }
                if !model.library.empty {
                    label("Your proxies").padding(.top, 22).padding(.bottom, 4)
                    ForEach(model.library.groups.prefix(6)) { group in
                        CheckRow(cc: nil, name: group.name, sub: group.size.map { "\($0) proxies" } ?? "A group") {
                            go { await checker.start(group: group.id) }
                        }
                    }
                    if !model.library.proxies.isEmpty {
                        CheckRow(cc: nil, name: "Your single proxies", sub: "\(model.library.proxies.count) saved") {
                            go { await checker.start(saved: true) }
                        }
                    }
                }
                if !checker.recent.isEmpty {
                    label("Recent checks").padding(.top, 22).padding(.bottom, 4)
                    ForEach(checker.recent.prefix(6)) { summary in
                        RecentRow(summary: summary) {
                            go { await checker.start(again: summary.id) }
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 2)
            .padding(.bottom, 30)
        }
        .sheet(isPresented: $typing) { TypeSheet() }
        .sheet(isPresented: $judging) {
            JudgeSheet().presentationDetents([.medium])
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.text]) { result in
            guard case .success(let url) = result else { return }
            let open = url.startAccessingSecurityScopedResource()
            defer { if open { url.stopAccessingSecurityScopedResource() } }
            let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                model.note = "empty: that file holds no text"
            } else {
                go { await checker.start(text: text) }
            }
        }
    }

    /// Start a run; the engine's refusal is said in red.
    private func go(_ start: @escaping () async -> String?) {
        Task {
            if let words = await start() { model.note = words }
        }
    }

    private var pasteCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            Image(systemName: "doc.on.clipboard")
                .font(.system(size: 24, weight: .semibold))
                .foregroundColor(.white)
            Text("Paste your proxies")
                .font(.system(size: 22, weight: .bold))
                .foregroundColor(.white)
                .padding(.top, 12)
            Text("Any format, one per line, as many as you like")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(C.onBlue)
                .padding(.top, 4)
            Group {
                if clipHasText {
                    // Apple's own paste button: it pastes when pressed, and iOS asks nothing.
                    PasteButton(payloadType: String.self) { strings in
                        let text = strings.joined(separator: "\n")
                        Task { @MainActor in
                            if let words = await checker.start(text: text) { model.note = words }
                        }
                    }
                    .tint(.white)
                    .labelStyle(.titleAndIcon)
                    .buttonBorderShape(.roundedRectangle(radius: 10))
                } else {
                    Button {
                        typing = true
                    } label: {
                        Label("Type them in", systemImage: "keyboard")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(C.blue)
                            .padding(.horizontal, 16)
                            .frame(minHeight: 44)
                            .background(Cut(big: 12, small: 4).fill(Color.white))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 16)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Cut(big: 26, small: 9).fill(C.blue))
        .onReceive(NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)) { _ in
            clipHasText = UIPasteboard.general.hasStrings
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            clipHasText = UIPasteboard.general.hasStrings
        }
    }

    private var judgeRow: some View {
        Button {
            judging = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.shield")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(C.ink2)
                Text("Judge ").font(.system(size: 14.5, weight: .semibold)).foregroundColor(C.ink2)
                    + Text(judgeKind.label).font(.system(size: 14.5, weight: .bold)).foregroundColor(C.ink)
                Spacer()
                Image(systemName: "chevron.down")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(C.ink2)
            }
            .padding(.horizontal, 14)
            .frame(height: 50)
            .overlay(Cut(big: 16, small: 6).stroke(C.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func label(_ words: String) -> some View {
        Text(words)
            .font(.system(size: 13, weight: .bold))
            .foregroundColor(C.ink3)
            .padding(.leading, 4)
    }

    private func way(_ icon: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 20, weight: .semibold))
                Text(title).font(.system(size: 13, weight: .bold))
            }
            .foregroundColor(C.ink)
            .frame(maxWidth: .infinity, minHeight: 68)
            .overlay(Cut(big: 16, small: 6).stroke(C.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct CheckRow: View {
    let cc: String?
    let name: String
    let sub: String
    let check: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            Group {
                if let cc, !flag(cc).isEmpty {
                    Text(flag(cc)).font(.system(size: 22))
                } else {
                    Image(systemName: "square.stack.3d.up").font(.system(size: 18, weight: .semibold)).foregroundColor(C.ink3)
                }
            }
            .frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.system(size: 16, weight: .bold)).foregroundColor(C.ink).lineLimit(1)
                Text(sub).font(.system(size: 13, weight: .medium)).foregroundColor(C.ink2).lineLimit(1)
            }
            Spacer()
            Button("Check", action: check)
                .font(.system(size: 15, weight: .bold))
                .foregroundColor(C.blueInk)
                .buttonStyle(.plain)
        }
        .frame(minHeight: 64)
    }
}

private struct RecentRow: View {
    let summary: CheckSummary
    let again: () -> Void

    var body: some View {
        Button(action: again) {
            HStack(spacing: 14) {
                Image(systemName: "checkmark.shield")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(C.ink2)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(summary.total) proxies").font(.system(size: 15.5, weight: .bold)).foregroundColor(C.ink)
                    Text(whenWas(summary.at)).font(.system(size: 13, weight: .medium)).foregroundColor(C.ink2)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    meter
                    // Working as the run counted it: the fast ones and the slow ones.
                    Text("\(summary.working + summary.slow) working")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(C.ink2)
                }
            }
            .frame(minHeight: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Checks the same proxies again")
    }

    private var meter: some View {
        let total = Double(max(summary.total, 1))
        return HStack(spacing: 0) {
            OK.frame(width: 72 * Double(summary.working) / total)
            WARN.frame(width: 72 * Double(summary.slow) / total)
            BAD.frame(width: 72 * Double(summary.bad) / total)
            Spacer(minLength: 0)
        }
        .frame(width: 72, height: 6)
        .background(C.s3)
        .clipShape(RoundedRectangle(cornerRadius: 3))
    }
}

// MARK: While it runs

private struct FlipRun: View {
    let run: CheckRun
    let open: (CheckCard) -> Void

    var body: some View {
        let working = run.working.count
        let landed = run.cards.filter { $0.answer != nil }.count
        ScrollView {
            VStack(spacing: 12) {
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(working)")
                            .font(.system(size: 52, weight: .heavy))
                            .foregroundColor(OK)
                        Text("working so far").font(.system(size: 13, weight: .semibold)).foregroundColor(C.ink2)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text("\(landed)/\(run.cards.count)").font(.system(size: 22, weight: .bold)).foregroundColor(C.ink)
                        Text("turned over").font(.system(size: 13, weight: .semibold)).foregroundColor(C.ink2)
                    }
                }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 6), spacing: 6) {
                    ForEach(run.cards) { card in
                        FlipCardView(card: card)
                            .onTapGesture { open(card) }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, 40)
        }
    }
}

/// One card. It turns over the moment its answer lands.
private struct FlipCardView: View {
    let card: CheckCard
    @State private var angle: Double = 0

    var body: some View {
        down
            .modifier(Turn(angle: angle, up: up))
            .aspectRatio(57.0 / 64.0, contentMode: .fit)
            .onAppear { if card.answer != nil { angle = 180 } }
            .onChange(of: card.answer != nil) { landed in
                if landed {
                    withAnimation(.timingCurve(0.3, 0.7, 0.3, 1, duration: 0.52)) { angle = 180 }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(card.answer.map { "\(card.address), \($0.says)" } ?? "\(card.address), checking")
    }

    private var down: some View {
        VStack(spacing: 3) {
            if let cc = card.cc, !flag(cc).isEmpty {
                Text(flag(cc)).font(.system(size: 14))
            } else {
                RoundedRectangle(cornerRadius: 3).fill(C.s3).frame(width: 20, height: 15)
            }
            Text(tail(card.address))
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(C.ink3)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Cut(big: 12, small: 5).fill(C.s2))
        .overlay(Cut(big: 12, small: 5).stroke(C.line, lineWidth: 1))
    }

    @ViewBuilder
    private var up: some View {
        if let answer = card.answer {
            let (big, small) = faceWords(answer)
            VStack(spacing: 3) {
                Text(big)
                    .font(.system(size: 15, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Text(small)
                    .font(.system(size: 9.5, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .foregroundColor(ink(answer.face))
            .padding(.horizontal, 3)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Cut(big: 12, small: 5).fill(colour(answer.face)))
        } else {
            Color.clear
        }
    }
}

/// The turn itself: the face-down side until the card stands on its edge, then the face,
/// drawn mirrored so its words read the right way round once over.
private struct Turn<Up: View>: ViewModifier, Animatable {
    var angle: Double
    let up: Up

    var animatableData: Double {
        get { angle }
        set { angle = newValue }
    }

    func body(content: Content) -> some View {
        ZStack {
            content.opacity(angle < 90 ? 1 : 0)
            up.rotation3DEffect(.degrees(180), axis: (x: 0, y: 1, z: 0)).opacity(angle < 90 ? 0 : 1)
        }
        .rotation3DEffect(.degrees(angle), axis: (x: 0, y: 1, z: 0), perspective: 0.5)
    }
}

// MARK: After a run

private struct DoneList: View {
    private enum Show { case working, all }

    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var checker: CheckerModel
    @AppStorage("judgeKind") private var judgeKind = JudgeKind.hproxy
    @State private var show = Show.working
    let run: CheckRun
    let open: (CheckCard) -> Void

    var body: some View {
        let working = run.working
        let rows = show == .working ? working : run.ordered
        let fastest = working.compactMap { $0.answer?.ms }.min()
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 14) {
                    Text("\(working.count)")
                        .font(.system(size: 46, weight: .heavy))
                        .foregroundColor(OK)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("working of \(run.cards.count)")
                        Text([fastest.map { "fastest \(speedWords($0))" }, "judge \(judgeKind.label)"].compactMap { $0 }.joined(separator: " · "))
                            .lineLimit(1)
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(C.ink2)
                }
                .padding(.top, 4)

                HStack(spacing: 8) {
                    LineButton(title: "Copy working", icon: "doc.on.doc", small: true, enabled: !working.isEmpty) {
                        Task {
                            let lines = await checker.lines(working)
                            guard !lines.isEmpty else { return }
                            UIPasteboard.general.string = lines.joined(separator: "\n")
                            model.say("\(lines.count) working \(lines.count == 1 ? "proxy" : "proxies") copied, as you pasted them")
                        }
                    }
                    LineButton(title: "Save", icon: "square.and.arrow.down", small: true, enabled: !working.isEmpty) {
                        Task {
                            let lines = await checker.lines(working)
                            guard !lines.isEmpty else { return }
                            if await model.addLines(lines.joined(separator: "\n"), asGroup: lines.count > 1) {
                                model.say(lines.count > 1 ? "\(lines.count) saved in My proxies, as a group" : "Saved in My proxies")
                            }
                        }
                    }
                    LineButton(title: "Again", icon: "arrow.clockwise", small: true) {
                        Task {
                            let lines = await checker.lines(run.cards)
                            guard !lines.isEmpty else { return }
                            if let words = await checker.start(text: lines.joined(separator: "\n")) { model.note = words }
                        }
                    }
                }
                .padding(.top, 14)

                HStack(spacing: 8) {
                    segment("Working \(working.count)", show == .working) { show = .working }
                    segment("All \(run.cards.count)", show == .all) { show = .all }
                }
                .padding(.top, 12)
                .padding(.bottom, 8)

                if rows.isEmpty {
                    Text("None of them works from this phone. All \(run.cards.count) shows why each one failed.")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(C.ink2)
                        .padding(.vertical, 24)
                }
                ForEach(rows) { card in
                    DoneRow(card: card, open: { open(card) })
                    C.line.frame(height: 1)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
    }

    /// Working or All: the chosen one solid blue, the other a hairline.
    private func segment(_ title: String, _ chosen: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .bold))
                .foregroundColor(chosen ? .white : C.ink2)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(Cut(big: 12, small: 4).fill(chosen ? C.blue : C.bg))
                .overlay(Cut(big: 12, small: 4).stroke(chosen ? C.blue : C.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

/// A checked proxy after the run: where it comes out and how fast, or why it fails.
private struct DoneRow: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var checker: CheckerModel
    let card: CheckCard
    let open: () -> Void

    var body: some View {
        let a = card.answer
        let usable = card.works
        HStack(spacing: 12) {
            Text(flag(a?.cc ?? card.cc).isEmpty ? " " : flag(a?.cc ?? card.cc))
                .font(.system(size: 22))
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 16, weight: .bold)).foregroundColor(usable ? C.ink : C.ink2).lineLimit(1)
                Text(sub).font(.system(size: 13, weight: .medium)).foregroundColor(subColour).lineLimit(1)
            }
            Spacer(minLength: 8)
            if usable, let ms = a?.ms {
                Text(speedWords(ms)).font(.system(size: 13, weight: .bold)).foregroundColor(C.ink2)
                Button {
                    Task {
                        guard let line = await checker.lines([card]).first else { return }
                        await model.use(line: line)
                    }
                } label: {
                    Image(systemName: "power")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(.white)
                        .frame(width: 40, height: 40)
                        .background(Cut(big: 12, small: 4).fill(C.blue))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Use on this phone")
            }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .onTapGesture(perform: open)
    }

    private var title: String {
        if let saved = model.library.proxies.first(where: { $0.address == card.address }),
           let name = saved.name, !name.trimmingCharacters(in: .whitespaces).isEmpty {
            return name
        }
        return card.address
    }

    private var sub: String {
        guard let a = card.answer else { return "Not checked" }
        if a.face == .slow { return a.says }
        if card.works {
            let words = [a.whereWords, a.way?.uppercased()].compactMap { $0 }.joined(separator: " · ")
            return words.isEmpty ? a.says : words
        }
        if a.face == .dead { return a.error.map(firstUp) ?? "No answer" }
        return a.says
    }

    private var subColour: Color {
        if card.works { return C.ink2 }
        return card.answer?.face == .dead ? C.ink3 : C.bad
    }
}

/// A checked proxy, opened: what it is, why it fails, use it or copy it.
private struct CardSheet: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var checker: CheckerModel
    @Environment(\.dismiss) private var dismiss
    let id: Int

    var body: some View {
        ScrollView {
            if let card = checker.run?.cards.first(where: { $0.i == id }) {
                content(card)
            }
        }
        .background(C.bg.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private func content(_ c: CheckCard) -> some View {
        let a = c.answer
        let tone: Color = {
            switch a?.face {
            case nil: return C.ink2
            case .good?: return C.ok
            case .slow?: return WARN
            case .dead?: return C.ink3
            default: return C.bad
            }
        }()
        let short: String = {
            guard let a else { return "Checking" }
            return a.face == .good ? "Working · \(a.ms ?? 0) ms" : a.says
        }()
        let long: String? = {
            guard let a, a.face != .good else { return nil }
            if a.face == .dead { return a.error.map(firstUp) ?? "No answer within 8 seconds: it is off, or it refuses you." }
            return a.why ?? a.says
        }()
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Text(flag(a?.cc ?? c.cc).isEmpty ? " " : flag(a?.cc ?? c.cc)).font(.system(size: 28))
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.address).font(.system(size: 18, weight: .bold)).foregroundColor(C.ink).lineLimit(1)
                    Text(short).font(.system(size: 13, weight: .semibold)).foregroundColor(tone).lineLimit(1)
                }
            }
            if let long {
                Text(long).font(.system(size: 14, weight: .semibold)).foregroundColor(C.ink2)
            }
            if let a {
                let facts: [(String, String)] = [
                    ("Protocol", a.way?.uppercased() ?? (a.protocols.isEmpty ? "None" : a.protocols.joined(separator: ", ").uppercased())),
                    ("Exits in", a.whereWords ?? "Not known"),
                    ("Network", a.datacenter == true ? "Data center" : a.datacenter == false ? "Home or mobile" : "Not known"),
                    ("Hides you", a.notes.contains("not_hidden") ? "No, sites see you" : a.notes.contains("tells_http_sites") ? "Tells http sites" : a.alive ? "Yes" : "Not known"),
                    ("Exit address", a.exitIp ?? "None"),
                    ("Answer", a.alive ? "\(a.ms ?? 0) ms" : "None"),
                ]
                LazyVGrid(columns: [GridItem(.flexible(), alignment: .topLeading), GridItem(.flexible(), alignment: .topLeading)], alignment: .leading, spacing: 10) {
                    ForEach(facts.indices, id: \.self) { n in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(facts[n].0).font(.system(size: 12, weight: .semibold)).foregroundColor(C.ink3)
                            Text(facts[n].1).font(.system(size: 14, weight: .bold)).foregroundColor(C.ink).lineLimit(2)
                        }
                    }
                }
            }
            HStack(spacing: 8) {
                if c.works {
                    Button("Use on this phone") {
                        dismiss()
                        Task {
                            guard let line = await checker.lines([c]).first else { return }
                            await model.use(line: line)
                        }
                    }
                    .buttonStyle(PrimaryButton())
                }
                LineButton(title: "Copy", icon: "doc.on.doc", height: 56) {
                    Task {
                        let line = await checker.lines([c]).first ?? c.address
                        UIPasteboard.general.string = line
                        model.say("\(c.address) copied")
                    }
                }
                .frame(maxWidth: c.works ? nil : .infinity)
            }
            .padding(.top, 8)
        }
        .padding(20)
    }
}

/// Type proxies in: one per line, any format, a keyboard that corrects nothing.
private struct TypeSheet: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var checker: CheckerModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 14) {
                ZStack(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("One per line, any format")
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
                Button("Check them") {
                    let typed = text
                    dismiss()
                    Task { if let words = await checker.start(text: typed) { model.note = words } }
                }
                .buttonStyle(PrimaryButton())
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Spacer()
            }
            .padding(20)
            .background(C.bg.ignoresSafeArea())
            .navigationTitle("Type your proxies")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

/// The judge: the address every proxy is asked to open. It answers with what it saw.
private struct JudgeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("judgeKind") private var judgeKind = JudgeKind.hproxy
    @AppStorage("judgeURL") private var judgeURL = ""

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 8) {
                Text("The address every proxy is asked to open. It answers with what it saw.")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(C.ink2)
                    .padding(.bottom, 6)
                ForEach(JudgeKind.allCases) { kind in
                    Button {
                        judgeKind = kind
                        if kind != .own { dismiss() }
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: judgeKind == kind ? "checkmark.circle.fill" : "circle")
                                .font(.system(size: 20, weight: .semibold))
                                .foregroundColor(judgeKind == kind ? C.blueInk : C.ink3)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(kind.label).font(.system(size: 16, weight: .bold)).foregroundColor(C.ink)
                                Text(kind.about).font(.system(size: 13, weight: .medium)).foregroundColor(C.ink2)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if judgeKind == .own {
                    TextField("http://your-judge.example/echo", text: $judgeURL)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(C.ink)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(.horizontal, 14)
                        .frame(height: 46)
                        .overlay(Cut(big: 14, small: 5).stroke(C.line, lineWidth: 1))
                }
                Spacer()
            }
            .padding(20)
            .background(C.bg.ignoresSafeArea())
            .navigationTitle("Judge")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

/// A button drawn as a hairline in the H's cut, icon and words: the quieter one beside the
/// solid blue.
struct LineButton: View {
    let title: String
    var icon: String?
    var small = false
    var enabled = true
    var height: CGFloat?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Image(systemName: icon).font(.system(size: small ? 13 : 15, weight: .bold)) }
                Text(title).font(.system(size: small ? 14 : 16, weight: .bold)).lineLimit(1)
            }
            .foregroundColor(enabled ? C.ink : C.ink3)
            .padding(.horizontal, small ? 12 : 16)
            .frame(minHeight: height ?? (small ? 38 : 48))
            .overlay(Cut(big: small ? 12 : 16, small: small ? 4 : 6).stroke(C.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}
