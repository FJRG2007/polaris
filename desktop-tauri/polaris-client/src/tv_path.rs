//! Which way a TV gets Polaris TV, decided from what was found on the network
//! and what the TV says about itself, never asked of the person.
//!
//! The Rust twin of `desktop/src/main/tv-path.ts`. Every per-brand difference
//! comes from the "Does it work on my TV?" data in core
//! (`dashboard/packages/core/src/tv-compat`), compiled in from those same JSON
//! files, so a model added there changes the install without a line changing
//! here.

use std::collections::HashSet;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

const PACKAGE: &str = "app.polaris.tv";
/// Android 8.0, the launcher's minSdk (`MIN_ANDROID` in the checker's rules).
pub const MIN_SDK: u32 = 26;

/// One listed model, as core's `tvModelSchema` holds it; only what the path needs is read.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct TvModel {
    pub id: String,
    pub brand: String,
    pub model: String,
    pub aliases: Vec<String>,
    pub platform: String,
    pub quirks: Vec<String>,
    /// desktop-network, desktop-usb, desktop-pairing or none.
    pub install: String,
}

/// Where one platform hides "turn on debugging", as core's `tvDebuggingSchema` holds it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct TvDebuggingSteps {
    pub id: String,
    pub platforms: Vec<String>,
    pub about: String,
    pub press: String,
    pub presses: u32,
    pub developer: String,
    pub switches: Vec<String>,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub localized: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct TvDebugging {
    platforms: Vec<TvDebuggingSteps>,
}

/// Core's model list, read once from the JSON compiled in.
pub fn tv_models() -> &'static [TvModel] {
    static MODELS: OnceLock<Vec<TvModel>> = OnceLock::new();
    MODELS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../dashboard/packages/core/src/tv-compat/models.json"
        ))
        .expect("core's tv-compat models.json matches its schema")
    })
}

fn debugging_steps() -> &'static [TvDebuggingSteps] {
    static STEPS: OnceLock<Vec<TvDebuggingSteps>> = OnceLock::new();
    STEPS.get_or_init(|| {
        let data: TvDebugging = serde_json::from_str(include_str!(
            "../../../dashboard/packages/core/src/tv-compat/debugging.json"
        ))
        .expect("core's tv-compat debugging.json matches its schema");
        data.platforms
    })
}

/// The services a TV announces over mDNS, by their service type without `._tcp`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TvService {
    Adb,
    AdbTlsConnect,
    AdbTlsPairing,
    Googlecast,
}

/// What discovery found at one address: a typed address or a port sweep hit has no services.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TvSighting {
    pub services: Vec<TvService>,
    /// The model a Cast record named (its `md` field), when one answered.
    pub cast_model: Option<String>,
    /// Whether the classic network debugging port answered.
    pub adb_open: bool,
}

/// What the TV says about itself once connected.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TvIdentity {
    pub manufacturer: String,
    pub model: String,
    /// The Android API level, None when it did not say.
    pub sdk: Option<u32>,
    /// Whether HOME_GUARD_PACKAGE is installed. None when it was not asked.
    pub home_guard: Option<bool>,
}

/// NES middleware's core service (TiVo Stream 4K, Nokia Streaming Box 8000): at
/// every boot it uninstalls each non-system app that declares the HOME category,
/// and the stock launcher's HOME priority leaves set-home-activity changing
/// nothing (tv/examples/tivo-stream-4k/README.md, "The launcher"). Such a box
/// gets the Home key edition instead.
pub const HOME_GUARD_PACKAGE: &str = "com.nes.coreservice";

/// standard: polaris-tv.apk. home-key: polaris-tv-home-key.apk, the same launcher
/// with no HOME category, opened from the remote's Home key by its accessibility service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TvEdition {
    Standard,
    HomeKey,
}

/// Whether `pm list packages <name>` listed that exact package, not one that only starts with it.
pub fn lists_package(listing: &str, name: &str) -> bool {
    let wanted = format!("package:{name}");
    listing.lines().any(|line| line.trim() == wanted)
}

/// network: the debugging port, now or once it is turned on. pairing: the TV
/// only opens debugging through Wireless debugging pairing. network-only: no
/// app on this TV, ad blocking through the Network filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TvRoute {
    Network,
    Pairing,
    NetworkOnly,
}

/// offered: the Home switch is the person's. app-only: the maker keeps Home.
/// refused-by-maker: switching Home has left this maker's sets unable to start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TvHomeRule {
    Offered,
    AppOnly,
    RefusedByMaker,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TvPath {
    pub route: TvRoute,
    pub home: TvHomeRule,
    /// The listed model this TV was matched to.
    pub model: Option<&'static TvModel>,
    pub platform: Option<String>,
    /// Why the path differs from a plain Android TV, as a quirk of the checker data.
    pub reason: Option<String>,
    /// Run by the installer after the install; never shown.
    pub after_install: Vec<String>,
    /// Which APK this TV gets.
    pub edition: TvEdition,
    /// Where the person turns debugging on, for this TV's platform.
    pub instruction: &'static TvDebuggingSteps,
}

/// TCL firmware keeps an app from starting itself without these app-ops
/// (`tv/addons/game-day/setup.sh`, `tv/addons/brightness/install.sh`).
pub fn tcl_appops() -> Vec<String> {
    vec![
        format!("appops set {PACKAGE} AUTO_START allow"),
        format!("cmd appops set {PACKAGE} APP_AUTO_START allow"),
    ]
}

/// A brand's first word, lowercase: "Amazon Fire TV" is "amazon".
fn maker_of(brand: &str) -> String {
    brand.split_whitespace().next().unwrap_or("").to_lowercase()
}

fn makers_with(quirk: &str) -> HashSet<String> {
    tv_models()
        .iter()
        .filter(|model| model.quirks.iter().any(|one| one == quirk))
        .map(|model| maker_of(&model.brand))
        .collect()
}

/// Makers whose Home switch is refused: Huawei by the quirk's own name, and every brand the data lists with that quirk.
fn refused_makers() -> &'static HashSet<String> {
    static MAKERS: OnceLock<HashSet<String>> = OnceLock::new();
    MAKERS.get_or_init(|| {
        let mut makers = makers_with("huawei-refusal");
        makers.insert("huawei".into());
        makers
    })
}

fn tcl_makers() -> &'static HashSet<String> {
    static MAKERS: OnceLock<HashSet<String>> = OnceLock::new();
    MAKERS.get_or_init(|| makers_with("tcl-autostart"))
}

/// The platform every listed model of a maker shares, or None when they differ.
fn maker_platform(maker: &str) -> Option<String> {
    let platforms: HashSet<&str> = tv_models()
        .iter()
        .filter(|model| maker_of(&model.brand) == maker)
        .map(|model| model.platform.as_str())
        .collect();
    (platforms.len() == 1).then(|| platforms.into_iter().next().unwrap_or_default().to_string())
}

fn steps_for(platform: Option<&str>) -> &'static TvDebuggingSteps {
    let steps = debugging_steps();
    platform
        .and_then(|platform| {
            steps
                .iter()
                .find(|entry| entry.platforms.iter().any(|one| one == platform))
        })
        .unwrap_or(&steps[0])
}

/// Core's `compactModel`: lowercase, with spaces, dashes and underscores gone.
pub fn compact_model(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-' && *character != '_')
        .collect()
}

/// The listed model a name means, only when its model text or an alias holds it whole.
pub fn match_model(name: Option<&str>, maker: Option<&str>) -> Option<&'static TvModel> {
    let typed = compact_model(name.unwrap_or(""));
    if typed.chars().count() < 3 {
        return None;
    }
    let maker = maker
        .filter(|maker| !maker.is_empty())
        .map(str::to_lowercase);
    let holds = |model: &&TvModel| {
        std::iter::once(&model.model)
            .chain(&model.aliases)
            .any(|text| compact_model(text).contains(&typed))
            && maker
                .as_ref()
                .is_none_or(|maker| &maker_of(&model.brand) == maker)
    };
    // The most specific entry wins: "55C71K" is the 55" set, not a listing that names a whole range.
    let mut found: Vec<&TvModel> = tv_models().iter().filter(holds).collect();
    found.sort_by_key(|model| compact_model(&model.model).encode_utf16().count());
    found.first().copied()
}

/// The way this TV gets Polaris TV. `identity` refines it once the TV answered.
pub fn choose_path(sighting: &TvSighting, identity: Option<&TvIdentity>) -> TvPath {
    let maker = identity.map(|identity| maker_of(&identity.manufacturer));
    let model = match_model(
        identity.map(|identity| identity.model.as_str()),
        maker.as_deref(),
    )
    .or_else(|| match_model(sighting.cast_model.as_deref(), None));
    let platform = model
        .map(|model| model.platform.clone())
        .or_else(|| maker.as_deref().and_then(maker_platform));
    let quirks: HashSet<&str> = model
        .map(|model| model.quirks.iter().map(String::as_str).collect())
        .unwrap_or_default();
    let maker_of_tv = maker
        .clone()
        .or_else(|| model.map(|model| maker_of(&model.brand)));
    let instruction = steps_for(platform.as_deref());
    let edition = if identity.and_then(|identity| identity.home_guard) == Some(true) {
        TvEdition::HomeKey
    } else {
        TvEdition::Standard
    };

    let too_old = identity
        .and_then(|identity| identity.sdk)
        .is_some_and(|sdk| sdk < MIN_SDK);
    if too_old || model.is_some_and(|model| model.install == "none") {
        let reason = if too_old {
            "android-too-old".to_string()
        } else {
            model
                .and_then(|model| model.quirks.first().cloned())
                .unwrap_or_else(|| "android-check".into())
        };
        return TvPath {
            route: TvRoute::NetworkOnly,
            home: TvHomeRule::AppOnly,
            model,
            platform,
            reason: Some(reason),
            after_install: Vec::new(),
            edition,
            instruction,
        };
    }

    let adb_open = sighting.adb_open || sighting.services.contains(&TvService::Adb);
    let tls_only = sighting
        .services
        .iter()
        .any(|service| matches!(service, TvService::AdbTlsConnect | TvService::AdbTlsPairing));
    let pairing = !adb_open
        && identity.is_none()
        && (tls_only || model.is_some_and(|model| model.install == "desktop-pairing"));

    let refused = quirks.contains("huawei-refusal")
        || maker_of_tv
            .as_ref()
            .is_some_and(|maker| refused_makers().contains(maker));
    let fire = platform.as_deref() == Some("fire-os") || quirks.contains("fire-home-amazon");
    // A TCL on Fire OS runs Amazon's firmware, not TCL's, so it has no such app-op.
    let tcl = quirks.contains("tcl-autostart")
        || (!fire
            && maker_of_tv
                .as_ref()
                .is_some_and(|maker| tcl_makers().contains(maker)));
    let home = if refused {
        TvHomeRule::RefusedByMaker
    } else if fire {
        TvHomeRule::AppOnly
    } else {
        TvHomeRule::Offered
    };
    let reason = if pairing {
        Some("google-pairing")
    } else if refused {
        Some("huawei-refusal")
    } else if fire {
        Some("fire-home-amazon")
    } else if tcl {
        Some("tcl-autostart")
    } else {
        None
    };
    TvPath {
        route: if pairing {
            TvRoute::Pairing
        } else {
            TvRoute::Network
        },
        home,
        model,
        platform,
        reason: reason.map(str::to_string),
        after_install: if tcl { tcl_appops() } else { Vec::new() },
        edition,
        instruction,
    }
}
