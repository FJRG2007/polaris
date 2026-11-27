use super::*;

#[test]
fn an_address_reduces_to_its_origin() {
    assert_eq!(
        normalize_address("  polaris.example.com ").as_deref(),
        Ok("https://polaris.example.com")
    );
    assert_eq!(
        normalize_address("https://polaris.example.com/home?x=1").as_deref(),
        Ok("https://polaris.example.com")
    );
    assert_eq!(
        normalize_address("http://192.168.1.10:3000/").as_deref(),
        Ok("http://192.168.1.10:3000")
    );
    assert_eq!(
        normalize_address("https://polaris.example.com:443").as_deref(),
        Ok("https://polaris.example.com")
    );
}

#[test]
fn an_address_that_is_not_a_polaris_page_is_refused() {
    assert!(normalize_address("").is_err());
    assert!(normalize_address("   ").is_err());
    assert!(normalize_address("ftp://polaris.example.com").is_err());
    assert!(normalize_address("https://user:pass@polaris.example.com").is_err());
    assert!(normalize_address("https://").is_err());
}

#[test]
fn the_approval_page_stays_on_the_instance() {
    assert_eq!(
        approve_url(
            "https://polaris.example.com",
            "/account/terminal?code=BCDF-GHJK"
        )
        .as_deref(),
        Some("https://polaris.example.com/account/terminal?code=BCDF-GHJK")
    );
    assert_eq!(
        approve_url("https://polaris.example.com", "https://evil.example"),
        None
    );
    assert_eq!(
        approve_url("https://polaris.example.com", "//evil.example/x"),
        None
    );
    assert_eq!(
        approve_url("https://polaris.example.com", r"/\evil.example"),
        None
    );
    assert_eq!(approve_url("https://polaris.example.com", "account"), None);
}

#[test]
fn the_poll_interval_is_bounded() {
    assert_eq!(poll_interval(None), DEFAULT_POLL);
    assert_eq!(poll_interval(Some(10)), DEFAULT_POLL);
    assert_eq!(poll_interval(Some(5_000)), Duration::from_secs(5));
    assert_eq!(poll_interval(Some(10_000_000)), LONGEST_POLL);
}

#[test]
fn a_claim_answer_reads_as_its_status() {
    let read = |json: &str| read_claim(serde_json::from_str(json).unwrap());
    assert_eq!(read(r#"{"status":"pending"}"#), Claimed::Pending);
    assert_eq!(read(r#"{"status":"denied"}"#), Claimed::Denied);
    assert_eq!(read(r#"{"status":"expired"}"#), Claimed::Expired);
    assert_eq!(
        read(r#"{"status":"approved","token":"plr_x","keyId":"k","scopes":[],"account":{}}"#),
        Claimed::Approved("plr_x".to_owned())
    );
    assert_eq!(read(r#"{"status":"approved"}"#), Claimed::Failed);
    assert_eq!(
        read(r#"{"status":"approved","token":" "}"#),
        Claimed::Failed
    );
    assert_eq!(read(r#"{"status":"something-new"}"#), Claimed::Failed);
}

#[test]
fn the_device_name_fits_the_instance_limit() {
    let name = device_name();
    assert!(!name.is_empty());
    assert!(name.chars().count() <= 80);
    assert!(!name.chars().any(char::is_control));
}
