//! A TV's address: a private IPv4 address and nothing else, so ADB is only ever
//! spoken to the local network. The Rust twin of `desktop/src/shared/tv-address.ts`.

/// The address in its plain dotted form, or None when it is not a private IPv4 address.
pub fn read_tv_address(value: &str) -> Option<String> {
    let parts: Vec<&str> = value.trim().split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut numbers = [0u16; 4];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        numbers[index] = part.parse().ok()?;
        if numbers[index] > 255 {
            return None;
        }
    }
    let [a, b, _, _] = numbers;
    let private = a == 10 || (a == 192 && b == 168) || (a == 172 && (16..=31).contains(&b));
    private.then(|| numbers.map(|number| number.to_string()).join("."))
}
