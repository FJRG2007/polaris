//! The install path for every model core lists, and for what discovery and the
//! TV itself say - the same cases as `desktop/test/main/tv-path.test.ts`.

use std::collections::HashSet;

use polaris_client::tv_path::*;

fn maker(model: &TvModel) -> String {
    model
        .brand
        .to_lowercase()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}

fn makers_with(quirk: &str) -> HashSet<String> {
    tv_models()
        .iter()
        .filter(|model| model.quirks.iter().any(|one| one == quirk))
        .map(maker)
        .collect()
}

fn swept() -> TvSighting {
    TvSighting {
        adb_open: true,
        ..TvSighting::default()
    }
}

#[test]
fn chooses_each_listed_models_path_from_the_checker_data() {
    let refused = makers_with("huawei-refusal");
    let tcl_makers = makers_with("tcl-autostart");
    assert!(tv_models().len() > 10);
    for model in tv_models() {
        let route = match model.install.as_str() {
            "none" => TvRoute::NetworkOnly,
            "desktop-pairing" => TvRoute::Pairing,
            _ => TvRoute::Network,
        };
        let has = |quirk: &str| model.quirks.iter().any(|one| one == quirk);
        let home = if model.install == "none" || has("fire-home-amazon") {
            TvHomeRule::AppOnly
        } else if refused.contains(&maker(model)) {
            TvHomeRule::RefusedByMaker
        } else {
            TvHomeRule::Offered
        };
        let tcl = has("tcl-autostart")
            || (tcl_makers.contains(&maker(model)) && model.platform != "fire-os");
        // Found by its Cast name, before connecting, with the debugging port still closed.
        let sighting = TvSighting {
            services: vec![TvService::Googlecast],
            cast_model: Some(model.model.clone()),
            adb_open: false,
        };
        let path = choose_path(&sighting, None);
        assert_eq!(
            path.model.map(|found| found.id.as_str()),
            Some(model.id.as_str()),
            "{}",
            model.id
        );
        assert_eq!(path.route, route, "{}", model.id);
        if route != TvRoute::NetworkOnly {
            assert_eq!(path.home, home, "{}", model.id);
            assert_eq!(
                path.after_install,
                if tcl { tcl_appops() } else { Vec::new() },
                "{}",
                model.id
            );
            assert!(
                path.instruction.platforms.contains(&model.platform),
                "{}",
                model.id
            );
        }
    }
}

#[test]
fn takes_the_debugging_port_when_it_answers_even_on_a_set_that_usually_needs_pairing() {
    let pairing = tv_models()
        .iter()
        .find(|model| model.install == "desktop-pairing")
        .unwrap();
    let open = TvSighting {
        cast_model: Some(pairing.model.clone()),
        ..swept()
    };
    assert_eq!(choose_path(&open, None).route, TvRoute::Network);
    let announced = TvSighting {
        services: vec![TvService::Adb],
        cast_model: Some(pairing.model.clone()),
        adb_open: false,
    };
    assert_eq!(choose_path(&announced, None).route, TvRoute::Network);
}

#[test]
fn needs_pairing_when_only_the_wireless_debugging_services_answer() {
    for service in [TvService::AdbTlsConnect, TvService::AdbTlsPairing] {
        let sighting = TvSighting {
            services: vec![service],
            ..TvSighting::default()
        };
        let path = choose_path(&sighting, None);
        assert_eq!(path.route, TvRoute::Pairing);
        assert_eq!(path.reason.as_deref(), Some("google-pairing"));
    }
}

#[test]
fn waits_on_a_typed_address_with_the_plain_android_tv_instruction() {
    let path = choose_path(&TvSighting::default(), None);
    assert_eq!(path.route, TvRoute::Network);
    assert_eq!(path.home, TvHomeRule::Offered);
    assert!(!path.instruction.switches.is_empty());
}

#[test]
fn does_not_guess_a_model_from_a_name_too_short_or_unknown() {
    assert!(match_model(Some("TV"), None).is_none());
    assert!(match_model(Some("Nothing Like It 9000"), None).is_none());
}

fn tv(manufacturer: &str, model: &str, sdk: Option<u32>) -> TvPath {
    let identity = TvIdentity {
        manufacturer: manufacturer.into(),
        model: model.into(),
        sdk,
        home_guard: None,
    };
    choose_path(&swept(), Some(&identity))
}

#[test]
fn refuses_the_home_switch_on_huawei_and_kalley_by_maker() {
    assert_eq!(
        tv("HUAWEI", "Unlisted 1", Some(30)).home,
        TvHomeRule::RefusedByMaker
    );
    assert_eq!(
        tv("Kalley", "Unlisted 1", Some(30)).home,
        TvHomeRule::RefusedByMaker
    );
    assert_eq!(
        tv("HUAWEI", "Unlisted 1", Some(30)).reason.as_deref(),
        Some("huawei-refusal")
    );
}

#[test]
fn keeps_fire_tv_an_app_with_home_left_to_amazon() {
    let path = tv("Amazon", "Unlisted 1", Some(30));
    assert_eq!(path.platform.as_deref(), Some("fire-os"));
    assert_eq!(path.home, TvHomeRule::AppOnly);
    assert_eq!(path.instruction.switches, vec!["ADB debugging"]);
}

#[test]
fn allows_tcls_autostart_app_ops_after_the_install() {
    let path = tv("TCL", "Unlisted 1", Some(30));
    assert_eq!(path.after_install, tcl_appops());
    assert_eq!(path.home, TvHomeRule::Offered);
    assert_eq!(path.reason.as_deref(), Some("tcl-autostart"));
}

#[test]
fn leaves_any_other_android_tv_the_home_switch_and_nothing_extra() {
    let path = tv("Sony", "Unlisted 1", Some(30));
    assert_eq!(path.route, TvRoute::Network);
    assert_eq!(path.home, TvHomeRule::Offered);
    assert!(path.after_install.is_empty());
    assert_eq!(path.reason, None);
}

#[test]
fn sends_a_tv_older_than_android_8_to_the_network_filter() {
    let path = tv("Sony", "Unlisted 1", Some(25));
    assert_eq!(path.route, TvRoute::NetworkOnly);
    assert_eq!(path.reason.as_deref(), Some("android-too-old"));
}

#[test]
fn never_needs_pairing_once_the_tv_has_answered() {
    let sighting = TvSighting {
        services: vec![TvService::AdbTlsPairing],
        ..TvSighting::default()
    };
    let identity = TvIdentity {
        manufacturer: "Google".into(),
        model: "x".into(),
        sdk: Some(34),
        home_guard: None,
    };
    assert_eq!(
        choose_path(&sighting, Some(&identity)).route,
        TvRoute::Network
    );
}

#[test]
fn gives_the_home_key_edition_only_to_a_box_running_nes_core_service() {
    let identity = |home_guard| TvIdentity {
        manufacturer: "Unlisted".into(),
        model: "Box 1".into(),
        sdk: Some(30),
        home_guard,
    };
    assert_eq!(
        choose_path(&swept(), Some(&identity(Some(true)))).edition,
        TvEdition::HomeKey
    );
    assert_eq!(
        choose_path(&swept(), Some(&identity(Some(true)))).home,
        TvHomeRule::Offered
    );
    assert_eq!(
        choose_path(&swept(), Some(&identity(Some(false)))).edition,
        TvEdition::Standard
    );
    assert_eq!(
        choose_path(&swept(), Some(&identity(None))).edition,
        TvEdition::Standard
    );
    assert_eq!(choose_path(&swept(), None).edition, TvEdition::Standard);
}

#[test]
fn matches_the_exact_package_in_pms_listing() {
    assert!(lists_package(
        "package:com.nes.coreservice\r\n",
        HOME_GUARD_PACKAGE
    ));
    assert!(!lists_package(
        "package:com.nes.coreservice.extra\n",
        HOME_GUARD_PACKAGE
    ));
    assert!(!lists_package("", HOME_GUARD_PACKAGE));
}
