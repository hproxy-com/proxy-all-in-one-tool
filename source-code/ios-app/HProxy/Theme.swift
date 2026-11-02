import SwiftUI

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 255) / 255,
            green: Double((hex >> 8) & 255) / 255,
            blue: Double(hex & 255) / 255
        )
    }
}

/// The app's one look, the phone app's (phone-android, Tokens.kt): dark, every fill a
/// solid colour, nothing see-through.
enum C {
    static let bg = Color(hex: 0x070A12)
    static let s1 = Color(hex: 0x0E1320)
    static let s2 = Color(hex: 0x161C2B)
    static let s3 = Color(hex: 0x1E2537)
    static let line = Color(hex: 0x232B3E)
    static let ink = Color(hex: 0xF4F6FB)
    static let ink2 = Color(hex: 0xA6AEC1)
    static let ink3 = Color(hex: 0x6C7489)
    static let blue = Color(hex: 0x0158FF)
    static let blueDeep = Color(hex: 0x0A3FCC)
    static let blueInk = Color(hex: 0x4D8BFF)
    static let onBlue = Color(hex: 0xCFDEFF)
    static let ok = Color(hex: 0x2FD07F)
    static let bad = Color(hex: 0xFF5A5F)
    /// A proxy that stopped: the page turns this, solid as the blue.
    static let stop = Color(hex: 0xC62828)
    static let stopDeep = Color(hex: 0x9E1F1F)
    static let onStop = Color(hex: 0xFFE3E3)
    static let mapLand = Color(hex: 0x1A2132)
    static let mapBlue = Color(hex: 0x2A6CFF)
    static let mapStop = Color(hex: 0xD23F3F)
}

/// The H's cut, on everything pressable: round top-left and bottom-right, nearly
/// square at the other two.
struct Cut: Shape {
    var big: CGFloat
    var small: CGFloat

    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(
            topLeadingRadius: big,
            bottomLeadingRadius: small,
            bottomTrailingRadius: big,
            topTrailingRadius: small,
            style: .circular
        )
        .path(in: rect)
    }
}

/// The real letterform, the logo's own paths on their 22 by 26 grid.
struct HLetter: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 0, y: 0))
        p.addCurve(
            to: CGPoint(x: 7.21633, y: 7.21633),
            control1: CGPoint(x: 3.98547, y: 0),
            control2: CGPoint(x: 7.21633, y: 3.23086)
        )
        p.addLine(to: CGPoint(x: 7.21633, y: 26))
        p.addLine(to: CGPoint(x: 0, y: 26))
        p.closeSubpath()
        p.addRect(CGRect(x: 14.2188, y: 0, width: 7.21633, height: 26))
        p.move(to: CGPoint(x: 7.2349, y: 26))
        p.addLine(to: CGPoint(x: 0, y: 26))
        p.addLine(to: CGPoint(x: 0, y: 15.9714))
        p.addCurve(
            to: CGPoint(x: 6.36735, y: 9.60408),
            control1: CGPoint(x: 0, y: 12.4548),
            control2: CGPoint(x: 2.85076, y: 9.60408)
        )
        p.addLine(to: CGPoint(x: 14.2204, y: 9.60408))
        p.addLine(to: CGPoint(x: 14.2204, y: 0))
        p.addLine(to: CGPoint(x: 21.4367, y: 0))
        p.addLine(to: CGPoint(x: 21.4367, y: 10.4531))
        p.addCurve(
            to: CGPoint(x: 15.0694, y: 16.8204),
            control1: CGPoint(x: 21.4367, y: 13.9696),
            control2: CGPoint(x: 18.586, y: 16.8204)
        )
        p.addLine(to: CGPoint(x: 7.2349, y: 16.8204))
        p.addLine(to: CGPoint(x: 7.2349, y: 26))
        p.closeSubpath()
        let scale = min(rect.width / 22, rect.height / 26)
        return p
            .applying(CGAffineTransform(scaleX: scale, y: scale))
            .offsetBy(dx: rect.minX + (rect.width - 22 * scale) / 2, dy: rect.minY + (rect.height - 26 * scale) / 2)
    }
}

/// The solid blue button of the app.
struct PrimaryButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .bold))
            .foregroundColor(isEnabled ? .white : C.ink3)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(Cut(big: 18, small: 6).fill(fill(pressed: configuration.isPressed)))
    }

    private func fill(pressed: Bool) -> Color {
        if !isEnabled { return C.s3 }
        return pressed ? C.blueDeep : C.blue
    }
}
