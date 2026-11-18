import SwiftUI

@main
struct HProxyApp: App {
    /// Reminders pressed open My proxies (Reminders.swift).
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()
    @AppStorage("welcomed") private var welcomed = false

    init() {
        // Solid, as everything here is: iOS draws its bars see-through otherwise.
        let bar = UINavigationBarAppearance()
        bar.configureWithOpaqueBackground()
        bar.backgroundColor = UIColor(C.bg)
        bar.shadowColor = .clear
        UINavigationBar.appearance().standardAppearance = bar
        UINavigationBar.appearance().compactAppearance = bar
        UINavigationBar.appearance().scrollEdgeAppearance = bar
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if welcomed {
                    RootView()
                } else {
                    WelcomeView { welcomed = true }
                }
            }
            .environmentObject(model)
            .environmentObject(model.checker)
            .environmentObject(model.chat)
            .preferredColorScheme(.dark)
        }
    }
}

/// The pages under a bar of our own: the system's tab bar is see-through, and floats as
/// a pill from iOS 26. The order is the phone app's (NavBar.kt), with Settings last.
struct RootView: View {
    enum Tab: Int, CaseIterable {
        case connect, proxies, checker, help, settings

        var title: String {
            switch self {
            case .connect: return "Connect"
            case .proxies: return "Proxies"
            case .checker: return "Checker"
            case .help: return "Help"
            case .settings: return "Settings"
            }
        }

        var icon: String {
            switch self {
            case .connect: return "power"
            case .proxies: return "list.bullet"
            case .checker: return "checkmark.shield"
            case .help: return "bubble.left.and.bubble.right"
            case .settings: return "slider.horizontal.3"
            }
        }
    }

    @EnvironmentObject private var model: AppModel
    @AppStorage("tab") private var tab = Tab.connect

    var body: some View {
        VStack(spacing: 0) {
            if let note = model.note {
                noteBar(note)
            }
            Group {
                switch tab {
                case .connect: ConnectView()
                case .proxies: ProxiesView()
                case .checker: CheckerView()
                case .help: HelpView()
                case .settings: SettingsView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if let toast = model.toast {
                toastBar(toast)
            }
            bar
        }
        .background(C.bg.ignoresSafeArea())
    }

    /// What went wrong, named and red. Pressing it puts it away.
    private func noteBar(_ words: String) -> some View {
        Button {
            model.note = nil
        } label: {
            Text(ErrorWords(words).line)
                .font(.system(size: 15, weight: .semibold))
                .multilineTextAlignment(.leading)
                .foregroundColor(.white)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(C.stop.ignoresSafeArea(edges: .top))
        }
        .buttonStyle(.plain)
    }

    /// That something worked, solid blue for a moment above the bar.
    private func toastBar(_ words: String) -> some View {
        Text(words)
            .font(.system(size: 15, weight: .semibold))
            .foregroundColor(.white)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(C.blue)
            .onTapGesture { model.toast = nil }
            .accessibilityAddTraits(.isStaticText)
    }

    private var bar: some View {
        HStack(spacing: 0) {
            ForEach(Tab.allCases, id: \.self) { item in
                Button {
                    tab = item
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: item.icon)
                            .font(.system(size: 20, weight: .semibold))
                            .frame(height: 24)
                        Text(item.title)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundColor(tab == item ? C.blueInk : C.ink3)
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(tab == item ? .isSelected : [])
            }
        }
        .background(C.s1.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) {
            C.line.frame(height: 1)
        }
    }
}
