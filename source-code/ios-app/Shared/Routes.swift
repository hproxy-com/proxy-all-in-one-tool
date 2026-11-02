/// The engine writes the tunnel's network as `address/length` (`vpnArgs`); iOS wants
/// the two apart, and for IPv4 the length as a mask.
struct Route: Equatable {
    let address: String
    let length: Int

    var isV6: Bool { address.contains(":") }

    /// The length as IPv4 writes it: 8 is 255.0.0.0.
    var mask: String {
        let bits = UInt32.max << (32 - length)
        return [24, 16, 8, 0].map { String((bits >> $0) & 255) }.joined(separator: ".")
    }

    init?(_ text: String) {
        let parts = text.split(separator: "/")
        guard parts.count == 2, let length = Int(parts[1]) else { return nil }
        address = String(parts[0])
        self.length = length
    }
}
