// Three requests through the rotating proxy with URLSession, each going out through the next
// proxy. macOS: the same code works in a macOS app.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   swift example.swift

import Foundation

let proxyHost = "127.0.0.1" // where hproxy connect listens
let proxyPort = 8080

func trace() async throws -> String {
    // A session keeps its connections, and with them their proxy. A new session for each request
    // opens a new connection: the next proxy. Keep one session to stay on the same address.
    let configuration = URLSessionConfiguration.ephemeral
    configuration.connectionProxyDictionary = [
        "HTTPEnable": 1,
        "HTTPProxy": proxyHost,
        "HTTPPort": proxyPort,
        "HTTPSEnable": 1,
        "HTTPSProxy": proxyHost,
        "HTTPSPort": proxyPort,
    ]
    configuration.timeoutIntervalForRequest = 30
    let session = URLSession(configuration: configuration)
    defer { session.finishTasksAndInvalidate() }
    let (data, _) = try await session.data(from: URL(string: "https://hproxy.com/cdn-cgi/trace")!)
    var seen: [String: String] = [:]
    for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
        let parts = line.split(separator: "=", maxSplits: 1)
        if parts.count == 2 { seen[String(parts[0])] = String(parts[1]) }
    }
    return "ip=\(seen["ip"] ?? "?") loc=\(seen["loc"] ?? "?")"
}

for i in 1...3 {
    print("\(i): \(try await trace())")
}
