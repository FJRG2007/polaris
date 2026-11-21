import UIKit

/// The app icon in the season's dress - a Santa hat at Christmas, a witch's hat at Halloween - the way the tab and
/// the desktop app wear it.
///
/// The page decides the season (the operator's switch and the reader's own opt-out included) and names it through
/// `polarisMobile.setSeasonIcon`. Each dress is an alternate icon in the asset catalog, generated from the same mark
/// as the web's by `mobile/scripts/season-icons.mjs`.
///
/// iOS shows its own "You have changed the icon" alert on every change and offers no way to change the icon without
/// it, so the icon is set only when it differs from the one up: the alert appears when a season starts and when it
/// ends, not on every launch. Any failure leaves the icon that was there.
enum SeasonIcon {
    /// The season the page names -> the alternate icon that wears it.
    private static let icons: [String: String] = [
        "halloween": "AppIcon-Halloween",
        "winter": "AppIcon-Winter",
        "newYear": "AppIcon-NewYear",
        "lunarNewYear": "AppIcon-LunarNewYear"
    ]

    /// The alternate icon for a season, or nil (the primary icon) for none or for a season this app predates.
    static func iconName(for season: String) -> String? {
        icons[season]
    }

    static func apply(_ season: String) {
        let wanted = iconName(for: season)
        let app = UIApplication.shared
        // Only an app on screen may change its icon; it is asked again on the next page load.
        guard app.supportsAlternateIcons, app.applicationState == .active, app.alternateIconName != wanted else { return }
        app.setAlternateIconName(wanted) { _ in
            // Refused or failed: the icon it had stays.
        }
    }
}
