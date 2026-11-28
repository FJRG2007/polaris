use super::*;

#[test]
fn relay_url_follows_the_origin_scheme() {
    assert_eq!(
        relay_url("https://polaris.example.com/").as_deref(),
        Some("wss://polaris.example.com/api/deploy/ws/terminal?role=instance")
    );
    assert_eq!(
        relay_url("http://192.168.1.10:3000").as_deref(),
        Some("ws://192.168.1.10:3000/api/deploy/ws/terminal?role=instance")
    );
    assert_eq!(relay_url("polaris.example.com"), None);
}

#[test]
fn debug_never_prints_the_key() {
    let account = PolarisAccount {
        origin: "https://polaris.example.com".to_owned(),
        key: "plr_secret".to_owned(),
        instance: None,
    };
    assert!(!format!("{account:?}").contains("plr_secret"));
}
