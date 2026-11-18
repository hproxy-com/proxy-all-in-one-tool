import UIKit
import UserNotifications

/// Reminders, as on the phone app (remind/Reminders.kt): saved proxies and groups close to
/// their last day say so, three days before and on the day itself, so a plan never ends
/// unnoticed. What is due and its words come from the library (hproxy-places, reminders.rs:
/// the same on every HProxy app) through the engine's `remindersDue`.
///
/// Android looks twice a day; iOS gives an app no such wake, so the reminders are planned
/// ahead instead: for each day one could fall on, the engine says what is due then, and iOS
/// shows it at 10:00 of that day on the phone's own calendar. Planned again whenever the
/// library changes. They name the proxy and the day, never a way to buy (guideline 3.1.1).
enum Reminders {
    private static let hour = 10

    private static var calendar: Calendar { Calendar.current }

    private static let dayFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Ask once, when a last day is first written (never at launch).
    static func ask() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }

    /// Plan every reminder the library's last days call for. Nothing when notifications are
    /// not allowed: the rows say it meanwhile.
    static func plan(_ library: Library) async {
        let center = UNUserNotificationCenter.current()
        let allowed = await center.notificationSettings().authorizationStatus
        guard allowed == .authorized || allowed == .provisional else { return }
        center.removeAllPendingNotificationRequests()

        let lastDays = library.proxies.compactMap(\.expires) + library.groups.compactMap(\.expires)
        var days = Set<String>()
        for written in lastDays {
            guard let last = dayFormat.date(from: written) else { continue }
            for before in [3, 0] {
                if let day = calendar.date(byAdding: .day, value: -before, to: last) {
                    days.insert(dayFormat.string(from: day))
                }
            }
        }
        let now = Date()
        // Later days first: the same reminder planned for an earlier day then wins.
        for day in days.sorted(by: >) {
            guard let date = dayFormat.date(from: day),
                  let at = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: date),
                  at > now,
                  let due = try? await Engine.call("remindersDue", ["today": day]) as? [[String: Any]]
            else { continue }
            for notice in due {
                guard let key = notice["key"] as? String, let title = notice["title"] as? String,
                      let body = notice["body"] as? String else { continue }
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                content.sound = .default
                let when = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: at)
                let request = UNNotificationRequest(
                    identifier: "reminder|\(key)",
                    content: content,
                    trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false)
                )
                try? await center.add(request)
            }
        }
    }

    /// "Ends in 2 days", "Ends today", "Ended": a last day in a row's words.
    static func words(_ written: String?) -> (words: String, soon: Bool)? {
        guard let written, let last = dayFormat.date(from: written) else { return nil }
        let today = calendar.startOfDay(for: Date())
        let days = calendar.dateComponents([.day], from: today, to: calendar.startOfDay(for: last)).day ?? 0
        switch days {
        case ..<0: return ("Ended", true)
        case 0: return ("Ends today", true)
        case 1: return ("Ends tomorrow", true)
        case 2...3: return ("Ends in \(days) days", true)
        default: return ("Ends \(last.formatted(.dateTime.month(.abbreviated).day()))", false)
        }
    }

    static func written(_ date: Date) -> String { dayFormat.string(from: date) }

    static func date(_ written: String?) -> Date? { written.flatMap { dayFormat.date(from: $0) } }
}

/// A reminder pressed opens My proxies; one arriving while the app is open still shows.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        UserDefaults.standard.set(RootView.Tab.proxies.rawValue, forKey: "tab")
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
