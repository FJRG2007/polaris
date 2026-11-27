use super::*;

#[test]
fn hash_matches_the_value_desktop_and_the_cli_send() {
    // Same input through `deviceIdFrom` in dashboard/packages/core/src/device-identity-node.ts.
    assert_eq!(
        device_id_from("  4C4C4544-0042-1010-8048-B4C04F4B4E32 "),
        "68f455217b626414d2de8d8cd6d106982b49797eca435b2ef282ef7278aac08b"
    );
}

#[test]
fn reads_the_windows_machine_guid() {
    let output = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    4c4c4544-0042-1010-8048-b4c04f4b4e32\r\n\r\n";
    assert_eq!(
        parse_windows_machine_guid(output).as_deref(),
        Some("4c4c4544-0042-1010-8048-b4c04f4b4e32")
    );
    assert_eq!(parse_windows_machine_guid("ERROR: not found"), None);
}

#[test]
fn reads_the_mac_platform_uuid() {
    let output = "+-o J314sAP  <class IOPlatformExpertDevice>\n    {\n      \"IOPlatformUUID\" = \"0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9\"\n    }\n";
    assert_eq!(
        parse_mac_platform_uuid(output).as_deref(),
        Some("0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9")
    );
    assert_eq!(
        parse_mac_platform_uuid("\"IOPlatformUUID\" = \"nope\""),
        None
    );
}

#[test]
fn reads_a_machine_id_file_and_rejects_anything_else() {
    assert_eq!(
        parse_machine_id_file("0123456789abcdef0123456789abcdef\n").as_deref(),
        Some("0123456789abcdef0123456789abcdef")
    );
    assert_eq!(parse_machine_id_file(""), None);
    assert_eq!(parse_machine_id_file("not a machine id"), None);
}
