import SwiftUI

/// The first screen, before anything else: what happens with your data, and how to
/// use the app (App Store guideline 5.4 asks for this before any use).
struct WelcomeView: View {
    var onDone: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HLetter().fill(C.blue).frame(width: 34, height: 40).padding(.top, 28)
                Text("Before you start")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundColor(C.ink)
                Text("HProxy connects this device through proxies you add yourself. It sells nothing and needs no account.")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(C.ink2)
                item("What stays here", "Your proxies and their logins stay on this device. We never see them.")
                item("What goes through a proxy", "While connected, your apps' traffic goes to the proxy you chose. Whoever runs that proxy can see where it goes, as with any proxy, so only use proxies you trust.")
                item("What reaches us", "When you connect or check proxies, a small test goes through each proxy to our server, or to the judge you chose, and we look up where its address is. That shows it works and where you appear. Neither leaves a record of you.")
                item("What you write to us", "If you write to support in Help, your messages reach HProxy support and stay in that chat, so we can answer.")
                item("What we never do", "We never sell your data, and we never use it or pass it to anyone for any other purpose. Usage counts stay off unless you switch them on in Settings.")
                Link("Privacy policy", destination: URL(string: "https://hproxy.com/privacy")!)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(C.blueInk)
                Button("Continue", action: onDone)
                    .buttonStyle(PrimaryButton())
                    .padding(.top, 6)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
        }
        .background(C.bg.ignoresSafeArea())
    }

    private func item(_ title: String, _ words: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 16, weight: .bold)).foregroundColor(C.ink)
            Text(words).font(.system(size: 15, weight: .medium)).foregroundColor(C.ink2)
        }
    }
}
