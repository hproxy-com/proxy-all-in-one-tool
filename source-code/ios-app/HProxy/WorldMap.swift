import SwiftUI

/// The world in dots, the same data as the other apps (WorldData.swift, generated
/// from the computer app's map): the land, and the country you appear in lit.
enum World {
    /// Cell number = row * cols + column, written in base 36 (worldDots.ts).
    private static func cells(_ text: Substring) -> [Int] {
        text.split(separator: ",").compactMap { Int($0, radix: 36) }
    }

    /// Every country's cells, by its lowercase code.
    static let countries: [String: [Int]] = {
        var all: [String: [Int]] = [:]
        for entry in WorldData.countries.split(separator: ";") {
            let parts = entry.split(separator: "=")
            if parts.count == 2 {
                all[String(parts[0])] = cells(parts[1])
            }
        }
        return all
    }()

    static let land: [Int] = countries.values.flatMap { $0 } + cells(WorldData.otherLand[...])

    /// The column a country's cells stand around: its middle, for the map to turn to.
    static func middle(of country: String?) -> CGFloat {
        guard let country, let cells = countries[country], !cells.isEmpty else {
            return CGFloat(WorldData.cols) / 2
        }
        let columns = cells.map { $0 % WorldData.cols }.sorted()
        return CGFloat(columns[columns.count / 2])
    }
}

/// In the top of the page, above the switch: big enough to read on a tall screen,
/// which shows a part of the world, turned so the lit country stands in the middle.
struct WorldMap: View {
    var land: Color
    var lit: Color
    /// The country lit, lowercase, if any.
    var country: String?

    var body: some View {
        Canvas { context, size in
            let cols = CGFloat(WorldData.cols)
            let rows = CGFloat(WorldData.rows)
            let pitch = max(size.width / cols, size.height * 0.38 / rows)
            let radius = pitch * 0.34
            let top = size.height * 0.26 - pitch * rows / 2
            let wanted = size.width / 2 - (World.middle(of: country) + 0.5) * pitch
            let left = min(0, max(size.width - pitch * cols, wanted))
            func dots(_ cells: [Int], _ color: Color) {
                var path = Path()
                for cell in cells {
                    let x = left + (CGFloat(cell % WorldData.cols) + 0.5) * pitch
                    let y = top + (CGFloat(cell / WorldData.cols) + 0.5) * pitch
                    path.addEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
                }
                context.fill(path, with: .color(color))
            }
            dots(World.land, land)
            if let country, let cells = World.countries[country] {
                dots(cells, lit)
            }
        }
        .allowsHitTesting(false)
    }
}
