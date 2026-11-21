//! Native runner: `cargo run --release -- 2 50 500`. Prints one JSON line per size.
fn main() {
    for n in std::env::args().skip(1).map(|a| a.parse::<usize>().unwrap()) {
        let messages = if n >= 1000 { 20 } else { 50 };
        println!("{}", serde_json::Value::Object(openmls_spike::run_size(n, messages)));
    }
}
