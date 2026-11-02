import SwiftUI

/// The connection: the world in dots, the H switch, and where you appear. On, the
/// page turns blue from where the knob lands; a proxy that stops turns it solid red.
struct ConnectView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("killSwitch") private var killSwitch = true
    @AppStorage("routeMode") private var routeMode = "all"
    @AppStorage("routeSites") private var routeSites = ""
    @AppStorage("firstHop") private var firstHop = ""
    @State private var picking = false
    @State private var adding = false

    private var choices: TunnelChoices {
        TunnelChoices(killSwitch: killSwitch, routeMode: routeMode, routeSites: routeSites, firstHop: firstHop)
    }

    private var on: Bool { model.phase == .on }
    private var failed: ErrorWords? { model.phase == .off ? model.failure.map(ErrorWords.init) : nil }
    private var stoppedError: ErrorWords? { model.health?.error.map(ErrorWords.init) }
    private var country: String? { model.health?.country_code?.lowercased() }

    var body: some View {
        ZStack {
            C.bg.ignoresSafeArea()
            WorldMap(land: C.mapLand, lit: C.blueInk, country: country).ignoresSafeArea()
            flood
            VStack(spacing: 0) {
                Spacer()
                Text(state)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(on ? words : failed != nil ? C.bad : C.ink2)
                track.padding(.top, 20)
                Text(big)
                    .font(.system(size: 28, weight: .bold))
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                    .foregroundColor(on ? .white : failed != nil ? C.bad : C.ink3)
                    .frame(height: 38)
                    .padding(.top, 26)
                Text(small)
                    .font(.system(size: 15, weight: .semibold))
                    .multilineTextAlignment(.center)
                    .foregroundColor(on ? words : failed != nil ? C.bad : C.ink2)
                    .padding(.top, 4)
                Spacer()
                placeCard
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 16)
        }
        .sheet(isPresented: $picking) {
            PlacePicker { place in
                picking = false
                model.connect(place, choices)
            }
        }
        .sheet(isPresented: $adding) { AddView() }
    }

    private var fill: Color { model.stopped ? C.stop : C.blue }
    private var fillDeep: Color { model.stopped ? C.stopDeep : C.blueDeep }
    private var words: Color { model.stopped ? C.onStop : C.onBlue }

    /// Solid at every moment: a growing circle uncovers it, with its own map, from
    /// where the knob lands.
    private var flood: some View {
        GeometryReader { geo in
            let reach = (geo.size.width * geo.size.width + geo.size.height * geo.size.height).squareRoot() * 2.2
            ZStack {
                fill
                WorldMap(land: model.stopped ? C.mapStop : C.mapBlue, lit: .white, country: country)
            }
            .mask {
                Circle()
                    .frame(width: on ? reach : 0, height: on ? reach : 0)
                    .position(x: geo.size.width / 2 + 74, y: geo.size.height * 0.46)
            }
            .animation(.timingCurve(0.2, 0.9, 0.1, 1, duration: 0.76), value: on)
        }
        .ignoresSafeArea()
    }

    private var state: String {
        switch model.phase {
        case .off: return failed != nil ? "Didn't work" : "Not connected"
        case .connecting: return "Reaching the proxy"
        case .leaving: return "Disconnecting"
        case .on: return model.stopped ? "Not answering" : "Connected"
        }
    }

    private var big: String {
        if on {
            if model.stopped { return stoppedError?.name.isEmpty == false ? stoppedError!.name : "No answer" }
            return model.health?.exit_ip ?? "…"
        }
        return failed?.name ?? ""
    }

    private var small: String {
        if on {
            if model.stopped {
                return killSwitch ? "Kill switch on: apps wait for it" : "You are on your own address until it answers"
            }
            let place = [model.health?.city, model.health?.country].compactMap { $0 }.joined(separator: ", ")
            guard let ms = model.health?.latency_ms else { return place.isEmpty ? "Checking where you appear" : place }
            return place.isEmpty ? "\(ms) ms" : "\(place) · \(ms) ms"
        }
        if let failed { return failed.detail }
        if model.phase == .connecting { return "Checking it works" }
        return "Your own address"
    }

    /// The switch: the H on a knob that lands left, in the middle while it connects, and right.
    private var track: some View {
        let width: CGFloat = 268
        let height: CGFloat = 120
        let knob: CGFloat = 104
        let travel = width - knob - 16
        let at: CGFloat = model.phase == .on ? travel : model.phase == .connecting ? travel / 2 : 0
        let lit = model.phase != .off || failed != nil
        return Button {
            if model.library.switchTo == nil {
                adding = true
            } else {
                model.toggle(choices)
            }
        } label: {
            ZStack(alignment: .leading) {
                Cut(big: 46, small: 16)
                    .fill(failed != nil ? C.stop : on ? fillDeep : C.s3)
                Cut(big: 38, small: 12)
                    .fill(lit ? Color.white : C.s2)
                    .overlay(HLetter().fill(failed != nil ? C.stop : lit ? fill : C.blueInk).frame(width: 42, height: 50))
                    .frame(width: knob, height: knob)
                    .offset(x: at + 8)
            }
            .frame(width: width, height: height)
            .animation(.timingCurve(0.34, 1.45, 0.6, 1, duration: 0.64), value: at)
        }
        .buttonStyle(.plain)
        .disabled(model.phase == .leaving)
        .accessibilityLabel(on ? "Disconnect" : "Connect")
    }

    /// The place: what the switch connects, and the way to another one.
    private var placeCard: some View {
        let title = model.library.switchTo.flatMap { model.library.title(of: $0) }
        return Button {
            if model.library.empty {
                adding = true
            } else {
                picking = true
            }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(on ? "Connected to" : "Your proxy")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(on ? C.nearBlackSoft : C.ink2)
                    Text(title ?? "Add your proxies first to start connecting!")
                        .font(.system(size: 16, weight: .bold))
                        .lineLimit(1)
                        .foregroundColor(on ? .black : C.ink)
                }
                Spacer()
                Text(model.library.empty ? "Add" : "Change")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(on ? fill : C.blueInk)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 72)
            .background(Cut(big: 22, small: 8).fill(on ? Color.white : C.s2))
        }
        .buttonStyle(.plain)
    }
}

extension C {
    static let nearBlackSoft = Color(hex: 0x4F5A70)
}

/// Your proxies and groups, to connect through one.
struct PlacePicker: View {
    @EnvironmentObject private var model: AppModel
    var onPick: (Place) -> Void

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.library.groups) { group in
                    Button(group.name) { onPick(.group(group.id)) }
                        .foregroundColor(C.ink)
                        .listRowBackground(C.s1)
                }
                ForEach(model.library.proxies) { proxy in
                    Button(proxy.title) { onPick(.proxy(proxy.id)) }
                        .foregroundColor(C.ink)
                        .listRowBackground(C.s1)
                }
            }
            .scrollContentBackground(.hidden)
            .background(C.bg)
            .navigationTitle("Connect through")
            .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.dark)
    }
}
