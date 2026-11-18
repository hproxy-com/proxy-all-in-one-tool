import SwiftUI

/// Help: talking to HProxy support, right here (the phone app's HelpTab.kt). The chat of
/// chat.hproxy.com, the same people who answer on the website. It says "HProxy support" and
/// nothing else about who runs it, and nothing in it leads to buying (guideline 3.1.1).
struct HelpView: View {
    @EnvironmentObject private var chat: SupportChat
    @FocusState private var writing: Bool

    private var state: String {
        switch chat.link {
        case .down: return "reconnecting"
        case .closed, .opening: return "connecting"
        case .open:
            if chat.online { return "online now" }
            guard let t = chat.replyTime else { return "usually answers within a few hours" }
            // "1-3 minutes" reads "usually answers in 1-3 minutes"; "within a day" as it is.
            return (t.first?.isNumber == true || t.hasPrefix("a ")) ? "usually answers in \(t)" : "usually answers \(t)"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Help")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundColor(C.ink)
                Spacer()
            }
            .padding(.horizontal, 20)
            .frame(height: 56)

            ScrollViewReader { scroller in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            HLetter().fill(C.blueInk).frame(width: 14, height: 16)
                            Text("HProxy support · \(state)")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(C.ink3)
                                .lineLimit(1)
                        }
                        .padding(.bottom, 4)
                        Bubble(text: "Hey 👋 This is a live chat with HProxy: ask us anything about the app and we'll help you.", mine: false, foot: nil, failed: false)
                        ForEach(chat.messages) { m in
                            Bubble(text: m.body, mine: m.mine, foot: foot(m), failed: m.sent == .failed)
                                .id(m.id)
                                .onTapGesture { if m.sent == .failed { chat.retry(m) } }
                        }
                        if chat.typing {
                            Text("Support is typing")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(C.ink3)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
                    .padding(.bottom, 16)
                }
                .scrollDismissesKeyboard(.interactively)
                .onTapGesture { writing = false }
                .onChange(of: chat.messages.count) { _ in
                    withAnimation { scroller.scrollTo("end", anchor: .bottom) }
                    if chat.messages.contains(where: { !$0.mine }) { chat.read() }
                }
                .onAppear { scroller.scrollTo("end", anchor: .bottom) }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(SupportChat.starters.indices, id: \.self) { n in
                        let starter = SupportChat.starters[n]
                        Button {
                            chat.draft = starter.start
                            writing = true
                        } label: {
                            Text(starter.word)
                                .font(.system(size: 13.5, weight: .bold))
                                .foregroundColor(C.ink)
                                .padding(.horizontal, 13)
                                .frame(height: 36)
                                .overlay(Cut(big: 12, small: 4).stroke(C.line, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
            }
            .frame(height: 50)

            bar
        }
        .background(C.bg.ignoresSafeArea())
        .onAppear {
            chat.open()
            if !chat.draft.isEmpty { writing = true }
        }
    }

    private var sendable: Bool {
        !chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !SupportChat.bare(chat.draft)
    }

    private var bar: some View {
        VStack(spacing: 0) {
            C.line.frame(height: 1)
            HStack(spacing: 6) {
                TextField("Write a message", text: $chat.draft, axis: .vertical)
                    .lineLimit(1...5)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(C.ink)
                    .textInputAutocapitalization(.sentences)
                    .focused($writing)
                    .submitLabel(.send)
                    .onSubmit { chat.send(chat.draft) }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(Cut(big: 14, small: 5).fill(C.s1))
                    .overlay(Cut(big: 14, small: 5).stroke(writing ? C.blue : C.line, lineWidth: 1))
                Button {
                    chat.send(chat.draft)
                } label: {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundColor(sendable ? C.blueInk : C.ink3)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .disabled(!sendable)
                .accessibilityLabel("Send")
            }
            .padding(.leading, 16)
            .padding(.trailing, 8)
            .padding(.vertical, 10)
        }
        .background(C.bg)
    }

    private func foot(_ m: SupportChat.Message) -> String? {
        let time = m.at.formatted(date: .omitted, time: .shortened)
        switch m.sent {
        case .sending: return "Sending"
        case .failed: return "Not sent · tap to send again"
        case .read: return "\(time) · Read"
        case .delivered: return time
        }
    }
}

/// One message. Yours solid blue on the right, support's on the left.
private struct Bubble: View {
    let text: String
    let mine: Bool
    let foot: String?
    let failed: Bool

    var body: some View {
        HStack {
            if mine { Spacer(minLength: 40) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
                Text(text)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(mine ? .white : C.ink)
                    .textSelection(.enabled)
                if let foot {
                    Text(foot)
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(failed ? .white : mine ? C.onBlue : C.ink3)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 11)
            .padding(.bottom, 9)
            .background(
                UnevenRoundedRectangle(
                    topLeadingRadius: 18,
                    bottomLeadingRadius: mine ? 18 : 6,
                    bottomTrailingRadius: mine ? 6 : 18,
                    topTrailingRadius: 18,
                    style: .circular
                )
                .fill(failed ? C.stop : mine ? C.blue : C.s2)
            )
            .frame(maxWidth: 300, alignment: mine ? .trailing : .leading)
            if !mine { Spacer(minLength: 40) }
        }
    }
}
