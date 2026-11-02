import Foundation

/// What the engine answered instead of a result, in its own words.
struct EngineError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// The Rust engine, the same one every other app of ours runs
/// (proxy-engine/hproxy-mobile, ffi.rs). Everything that touches a proxy happens
/// there: JSON goes in, JSON comes out.
enum Engine {
    static let appGroup = "group.com.hproxy.app"

    /// Its calls block, some for as long as a proxy takes to answer, so they run off
    /// the main thread, and side by side so one that waits holds up no other.
    private static let queue = DispatchQueue(label: "com.hproxy.engine", attributes: .concurrent)

    /// The folder the app and its tunnel share.
    static var folder: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    /// Start the engine. The tunnel's process only reads the library: the app owns it.
    static func start(inTunnel: Bool) async throws {
        try await offMain {
            var shared = folder
            try FileManager.default.createDirectory(at: shared, withIntermediateDirectories: true)
            // Logins never leave the phone, and iOS would copy this folder into its backups.
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try shared.setResourceValues(values)
            try read(hproxy_init(shared.path, inTunnel))
        }
    }

    @discardableResult
    static func call(_ method: String, _ args: [String: Any] = [:]) async throws -> Any {
        let data = try JSONSerialization.data(withJSONObject: args)
        let text = String(decoding: data, as: UTF8.self)
        return try await offMain { try read(hproxy_call(method, text)) }
    }

    /// The next thing that happened on its own, or nil after the wait.
    static func poll(milliseconds: Int32) async -> [String: Any]? {
        try? await offMain { () -> [String: Any]? in
            guard let raw = hproxy_poll(milliseconds) else { return nil }
            defer { hproxy_free(raw) }
            let data = Data(bytes: raw, count: strlen(raw))
            return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
    }

    /// `value` as one of the models.
    static func decode<T: Decodable>(_ type: T.Type, from value: Any) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// An answer of the engine: its value, or its words as an error.
    @discardableResult
    static func read(_ raw: UnsafeMutablePointer<CChar>?) throws -> Any {
        guard let raw else { throw EngineError(message: "The engine did not answer") }
        defer { hproxy_free(raw) }
        let data = Data(bytes: raw, count: strlen(raw))
        guard let answer = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw EngineError(message: "The engine did not answer")
        }
        if answer["ok"] as? Bool == true {
            return answer["value"] ?? NSNull()
        }
        throw EngineError(message: (answer["error"] as? String) ?? "Something went wrong")
    }

    private static func offMain<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { done in
            queue.async {
                done.resume(with: Result(catching: work))
            }
        }
    }

    /// Why the tunnel's last start failed, kept in a file: a tunnel's own error reaches
    /// the app without words, and a file is there the moment the app looks.
    static var lastError: String? {
        get { try? String(contentsOf: lastErrorFile, encoding: .utf8) }
        set {
            if let newValue {
                try? newValue.write(to: lastErrorFile, atomically: true, encoding: .utf8)
            } else {
                try? FileManager.default.removeItem(at: lastErrorFile)
            }
        }
    }

    private static var lastErrorFile: URL { folder.appendingPathComponent("last-error.txt") }
}
