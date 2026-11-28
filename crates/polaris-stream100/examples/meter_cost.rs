//! What metering every channel costs: this process's CPU time over ten
//! seconds of waking 25 times a second, once doing nothing and once reading
//! every session's and the output's peak meter. Windows only, no device needed:
//!
//!   cargo run --release -p polaris-stream100 --features native --example meter_cost

#[cfg(windows)]
fn cpu() -> std::time::Duration {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    // SAFETY: the current process's own times, into locals.
    unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    }
    .expect("process times");
    let ticks =
        |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    std::time::Duration::from_nanos((ticks(kernel) + ticks(user)) * 100)
}

#[cfg(windows)]
fn main() {
    use std::time::{Duration, Instant};
    let mut mixer = polaris_stream100::native::open().expect("this computer's audio");
    let sessions = mixer.sessions().expect("the sessions");
    let span = Duration::from_secs(10);
    let every = Duration::from_millis(40);
    let run = |read: &mut dyn FnMut()| {
        let (start, before) = (Instant::now(), cpu());
        let mut reads = 0u32;
        while start.elapsed() < span {
            read();
            reads += 1;
            std::thread::sleep(every);
        }
        let used = cpu() - before;
        (
            used,
            reads,
            used.as_secs_f64() / start.elapsed().as_secs_f64() * 100.0,
        )
    };
    let (idle, idle_reads, idle_share) = run(&mut || {});
    let mut peaks = 0usize;
    let (metered, reads, share) = run(&mut || {
        peaks = mixer.peaks().map(|all| all.len()).unwrap_or(0);
        let _ = mixer.output_peak();
    });
    println!(
        "sessions: {}, meters read each time: {peaks} + output",
        sessions.len()
    );
    println!(
        "waking only: {idle_reads} wakes, {:.1} ms CPU, {idle_share:.3}% of one core",
        idle.as_secs_f64() * 1000.0
    );
    println!(
        "metering:    {reads} reads, {:.1} ms CPU, {share:.3}% of one core",
        metered.as_secs_f64() * 1000.0
    );
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only.");
}
