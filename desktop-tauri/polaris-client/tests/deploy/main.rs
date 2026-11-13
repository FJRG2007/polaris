//! The deploy side: zip rules, folder zips, the docker arguments, deployment
//! notices, the streamed upload and a whole push. Docker is never run: the push
//! uses fake tools, and process handling runs this test binary as a fake program.

use polaris_client::api::KEY_REFUSED;
use polaris_client::deploy_outcome::{deploy_outcome, first_line};
use polaris_client::docker::{self, build_args, docker_path, Lines, Run};
use polaris_client::folder_zip::{list_folder, zip_entries, zip_folder, FolderEntry, FolderError};
use polaris_client::push_local::{
    self, commit_meta, encode_uri_component, CommitMeta, PushEvent, PushPhase, PushPlan, Tools,
};
use polaris_client::zip_rules::{
    folder_too_large, format_bytes, skipped, zip_too_large, EMPTY_FOLDER, MAX_FOLDER, MAX_ZIP,
};
use polaris_client::{ApiClient, ApiKey, InstanceUrl};
use serde_json::json;
use std::ffi::{OsStr, OsString};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{body_string, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const KEY: &str = "plk_abcd1234.fixture-secret";
const SERVICE: &str = "0b6f8d2e-1c1a-4c55-9a51-7c1b2f4f8e01";
const MARKER: &str = "polaris_fake_marker";

// ---- fake programs: this binary, started on one of these tests ------------

fn faked() -> bool {
    std::env::args().any(|arg| arg == MARKER)
}

#[test]
fn fake_lines() {
    if faked() {
        // libtest has printed its own line up to here; this starts a fresh one.
        print!("\none\r\ntwo\rthree\n");
        std::io::stdout().flush().unwrap();
        eprint!("\nlast words");
        std::process::exit(3);
    }
}

#[test]
fn fake_save() {
    if faked() {
        let mut out = std::io::stdout().lock();
        for _ in 0..64 {
            out.write_all(&[7u8; 4096]).unwrap();
        }
        out.flush().unwrap();
        std::process::exit(0);
    }
}

#[test]
fn fake_save_fails() {
    if faked() {
        eprint!("pulling\nError: No such image: reg/app:x\n");
        std::process::exit(1);
    }
}

#[test]
fn fake_sleep() {
    if faked() {
        std::thread::sleep(std::time::Duration::from_secs(30));
        std::process::exit(0);
    }
}

fn fake(name: &str) -> (PathBuf, Vec<OsString>) {
    let exe = std::env::current_exe().unwrap();
    (
        exe,
        ["--exact", name, MARKER, "--nocapture", "--test-threads=1"]
            .into_iter()
            .map(OsString::from)
            .collect(),
    )
}

// ---- zip rules --------------------------------------------------------------

#[test]
fn skips_what_the_browser_zipper_skips() {
    for path in [
        "app/node_modules",
        "app/node_modules/react/index.js",
        "app/packages/web/node_modules/x.js",
        "app/.git/HEAD",
        "app/__MACOSX/._index.js",
        "app/.DS_Store",
        "app/src/.DS_Store",
    ] {
        assert!(skipped(path), "{path}");
    }
    for path in [
        "app/node_modules_backup/x.js",
        "app/.github/workflows/ci.yml",
        "app/.gitignore",
        "app/src/git.ts",
    ] {
        assert!(!skipped(path), "{path}");
    }
}

#[test]
fn keeps_the_dashboard_limits_and_words() {
    assert_eq!(MAX_ZIP, 200 * 1024 * 1024);
    assert_eq!(MAX_FOLDER, 1024 * 1024 * 1024);
    assert_eq!(folder_too_large(), "That folder holds more than 1 GB.");
    assert_eq!(
        zip_too_large(),
        "Zipped, that folder is larger than 200 MB."
    );
    assert_eq!(format_bytes(1536), "1.5 KB");
    assert_eq!(format_bytes(12), "12 B");
}

#[test]
fn matches_the_browser_zipper_source() {
    // The two cannot share code, so the copy is checked against the original.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let browser = std::fs::read_to_string(
        root.join("dashboard/apps/web/src/app/(app)/apps/deploy/upload-source.tsx"),
    )
    .unwrap();
    let electron = std::fs::read_to_string(root.join("desktop/src/main/zip-rules.ts")).unwrap();
    for source in [&browser, &electron] {
        assert!(
            source.contains(r#"const SKIPPED = new Set(["node_modules", ".git", "__MACOSX"]);"#)
        );
        assert!(source.contains("const MAX_ZIP = 200 * 1024 ** 2;"));
        assert!(source.contains("const MAX_FOLDER = 1024 ** 3;"));
        assert!(source.contains(r#"path.split("/").some((segment) => SKIPPED.has(segment)) || path.endsWith(".DS_Store")"#));
    }
}

// ---- folder zip -------------------------------------------------------------

fn project(root: &Path) -> PathBuf {
    let app = root.join("my-app");
    for dir in [
        "src/lib",
        "node_modules/react",
        ".git/objects",
        "packages/web/node_modules/x",
        ".github",
    ] {
        std::fs::create_dir_all(app.join(dir)).unwrap();
    }
    for (file, text) in [
        ("package.json", r#"{"name":"my-app"}"#),
        ("src/index.ts", "export const a = 1;\n"),
        ("src/lib/util.ts", "export const b = 2;\n"),
        (".github/ci.yml", "on: push\n"),
        (".gitignore", "node_modules\n"),
        (".DS_Store", "junk"),
        ("node_modules/react/index.js", "module.exports = {};\n"),
        (".git/HEAD", "ref: refs/heads/main\n"),
        ("packages/web/node_modules/x/y.js", "1"),
    ] {
        std::fs::write(app.join(file), text).unwrap();
    }
    app
}

fn names_in(zip: Vec<u8>) -> Vec<String> {
    let archive = zip::ZipArchive::new(Cursor::new(zip)).unwrap();
    let mut names: Vec<String> = archive
        .file_names()
        .map(|name| name.unwrap().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn zips_everything_under_the_folder_name_without_skipped_entries() {
    let root = tempfile::tempdir().unwrap();
    let app = project(root.path());
    let (zipped, out) = zip_folder(&app, Cursor::new(Vec::new())).unwrap();
    assert_eq!(zipped.name, "my-app");
    assert_eq!(zipped.files, 5);
    let bytes = out.into_inner();
    assert_eq!(
        names_in(bytes.clone()),
        [
            "my-app/.github/ci.yml",
            "my-app/.gitignore",
            "my-app/package.json",
            "my-app/src/index.ts",
            "my-app/src/lib/util.ts"
        ]
    );
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut text = String::new();
    archive
        .by_name("my-app/src/index.ts")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, "export const a = 1;\n");
}

/// A directory link anybody may make: a junction on Windows, a symlink elsewhere.
fn link_dir(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args([
                OsStr::new("/C"),
                OsStr::new("mklink"),
                OsStr::new("/J"),
                link.as_os_str(),
                target.as_os_str(),
            ])
            .output()
            .is_ok_and(|out| out.status.success())
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

#[test]
fn follows_links_inside_the_folder_only_and_ends_loops() {
    let root = tempfile::tempdir().unwrap();
    let app = project(root.path());
    let outside = root.path().join("elsewhere");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "do not send").unwrap();
    if !link_dir(&app.join("src/lib"), &app.join("shared")) {
        return;
    }
    assert!(link_dir(&outside, &app.join("outside")));
    assert!(link_dir(&app, &app.join("src/lib/up")));
    assert!(link_dir(&app.join("src"), &app.join("src/lib/again")));
    std::fs::create_dir(app.join("a")).unwrap();
    std::fs::create_dir(app.join("b")).unwrap();
    std::fs::write(app.join("b/b.txt"), "b").unwrap();
    assert!(link_dir(&app.join("b"), &app.join("a/to-b")));
    assert!(link_dir(&app.join("a"), &app.join("b/to-a")));
    let names: Vec<String> = list_folder(&app)
        .unwrap()
        .into_iter()
        .map(|entry| entry.path)
        .collect();
    assert!(
        names.contains(&"my-app/shared/util.ts".to_owned()),
        "{names:?}"
    );
    assert!(names.contains(&"my-app/src/lib/util.ts".to_owned()));
    assert!(!names.iter().any(|name| name.starts_with("my-app/outside")));
    assert!(!names
        .iter()
        .any(|name| name.contains("/up/") || name.contains("/again/")));
    assert!(names.contains(&"my-app/b/b.txt".to_owned()));
    assert!(names.contains(&"my-app/a/to-b/b.txt".to_owned()));
    let unique: std::collections::HashSet<&String> = names.iter().collect();
    assert_eq!(unique.len(), names.len());
}

#[test]
fn refuses_a_folder_with_nothing_to_send() {
    let root = tempfile::tempdir().unwrap();
    let empty = root.path().join("empty");
    std::fs::create_dir_all(empty.join("node_modules/x")).unwrap();
    std::fs::write(empty.join("node_modules/x/a.js"), "1").unwrap();
    let refused = zip_folder(&empty, Cursor::new(Vec::new())).unwrap_err();
    assert!(matches!(&refused, FolderError::Refusal(text) if text == EMPTY_FOLDER));
}

#[test]
fn refuses_a_zip_past_the_server_limit_without_holding_it() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("noise.bin");
    // Random bytes do not compress, so the zip is as large as the file.
    let mut chunk = vec![0u8; 1024 * 1024];
    aws_lc_rs::rand::fill(&mut chunk).unwrap();
    let mut out = std::fs::File::create(&file).unwrap();
    for _ in 0..=200 {
        out.write_all(&chunk).unwrap();
    }
    drop(out);
    let size = std::fs::metadata(&file).unwrap().len();
    let entry = FolderEntry {
        path: "big/noise.bin".into(),
        file,
        size,
        modified: None,
    };
    let sink = tempfile::tempfile().unwrap();
    let refused = zip_entries(&[entry], sink).unwrap_err();
    assert!(matches!(&refused, FolderError::Refusal(text) if *text == zip_too_large()));
}

// ---- docker and notices -------------------------------------------------------

#[test]
fn builds_like_the_cli() {
    let plain: Vec<OsString> = ["build", "-t", "reg/app:abc", "/work/app"]
        .into_iter()
        .map(OsString::from)
        .collect();
    assert_eq!(
        build_args("reg/app:abc", OsStr::new("/work/app"), ""),
        plain
    );
    let platform: Vec<OsString> = [
        "build",
        "-t",
        "reg/app:abc",
        "--platform",
        "linux/amd64",
        "C:\\work\\my app",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    assert_eq!(
        build_args("reg/app:abc", OsStr::new("C:\\work\\my app"), "linux/amd64"),
        platform
    );
}

#[test]
fn adds_dockers_usual_places_after_path_once() {
    let path = docker_path(
        Some(OsStr::new("/usr/bin:/bin:/usr/local/bin")),
        "macos",
        Path::new("/Users/fixture"),
    )
    .unwrap();
    let parts: Vec<String> = path
        .to_string_lossy()
        .split(':')
        .map(str::to_owned)
        .collect();
    assert_eq!(parts[..3], ["/usr/bin", "/bin", "/usr/local/bin"]);
    assert!(parts.contains(&"/opt/homebrew/bin".to_owned()));
    assert!(parts.contains(&"/Users/fixture/.docker/bin".to_owned()));
    assert_eq!(
        parts
            .iter()
            .filter(|part| *part == "/usr/local/bin")
            .count(),
        1
    );
    assert_eq!(
        docker_path(
            Some(OsStr::new("C:\\Windows")),
            "windows",
            Path::new("C:\\")
        ),
        None
    );
}

#[test]
fn announces_a_finished_deployment_like_the_dashboard() {
    let ok = deploy_outcome("shop / api", "running", None);
    assert!(ok.ok);
    assert_eq!(ok.title, "Deployed shop / api");
    assert_eq!(ok.body, "shop / api is serving the new release.");
    assert!(deploy_outcome("api", "success", None).ok);
    let failed = deploy_outcome("api", "failed", Some("\n  Error: port 3000 in use\nat x"));
    assert_eq!(
        (failed.ok, failed.title.as_str(), failed.body.as_str()),
        (false, "Deploy failed: api", "Error: port 3000 in use")
    );
    assert!(!deploy_outcome("api", "cancelled", None).ok);
    assert!(first_line(None).starts_with("No reason was reported"));
    assert_eq!(first_line(Some(&"x".repeat(400))).len(), 300);
}

#[test]
fn splits_printed_lines_across_chunks() {
    let mut lines = Lines::default();
    let mut seen = Vec::new();
    for chunk in [&b"a\r"[..], b"\nb\rc", b"\n\xc3", b"\xa9\npartial"] {
        lines.push(chunk, |line| seen.push(line));
    }
    lines.finish(|line| seen.push(line));
    assert_eq!(seen, ["a", "b", "c", "\u{e9}", "partial"]);
    let mut log = Lines::newline_only();
    let mut kept = Vec::new();
    log.push(b"50%\r100%\ndone", |line| kept.push(line));
    log.finish(|line| kept.push(line));
    assert_eq!(kept, ["50%\r100%", "done"]);
}

#[test]
fn reads_the_commit_like_the_electron_app() {
    let sha = "a".repeat(40);
    let ok = Run {
        code: Some(0),
        tail: vec![format!("{sha}\n")],
    };
    let message = Run {
        code: Some(0),
        tail: vec!["fix: things".into()],
    };
    assert_eq!(
        commit_meta(&ok, &message),
        Some(CommitMeta {
            sha: sha.clone(),
            message: "fix: things".into()
        })
    );
    assert_eq!(
        commit_meta(
            &Run {
                code: Some(128),
                tail: vec![sha]
            },
            &message
        ),
        None
    );
    assert_eq!(
        commit_meta(
            &Run {
                code: Some(0),
                tail: vec!["HEAD".into()]
            },
            &message
        ),
        None
    );
    assert_eq!(
        encode_uri_component("fix: a/b (x) \u{f1}"),
        "fix%3A%20a%2Fb%20(x)%20%C3%B1"
    );
}

#[tokio::test]
async fn runs_a_program_with_its_lines_and_exit_code() {
    let (exe, args) = fake("fake_lines");
    let mut seen = Vec::new();
    let run = docker::run(&exe, &args, None, &CancellationToken::new(), |line| {
        seen.push(line.to_owned())
    })
    .await
    .unwrap();
    assert_eq!(run.code, Some(3));
    for line in ["one", "two", "three", "last words"] {
        assert!(seen.contains(&line.to_owned()), "{seen:?}");
    }
    assert!(run.tail.len() <= 20);
}

#[tokio::test]
async fn a_canceled_run_ends_the_program() {
    let (exe, args) = fake("fake_sleep");
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        stop.cancel();
    });
    let started = std::time::Instant::now();
    let error = docker::run(&exe, &args, None, &cancel, |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
    let missing = docker::run(
        "polaris-no-such-program",
        &[],
        None,
        &CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(missing.kind(), std::io::ErrorKind::NotFound);
    assert_eq!(
        docker::docker_ready("polaris-no-such-program")
            .await
            .unwrap_err(),
        "Docker is not installed on this computer, so nothing can be built here."
    );
}

#[tokio::test]
async fn saves_an_image_gzipped_and_says_why_it_failed() {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("image.tar.gz");
    let (exe, args) = fake("fake_save");
    push_local::save_image(&exe, &args, &archive, &CancellationToken::new())
        .await
        .unwrap();
    let mut unzipped = Vec::new();
    flate2::read::GzDecoder::new(std::fs::File::open(&archive).unwrap())
        .read_to_end(&mut unzipped)
        .unwrap();
    assert!(unzipped.ends_with(&[7u8; 64 * 4096]));
    let (exe, args) = fake("fake_save_fails");
    let error = push_local::save_image(&exe, &args, &archive, &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "docker save exited with 1: Error: No such image: reg/app:x"
    );
}

// ---- a whole push, with fake tools and a mock Polaris ---------------------------

struct FakeTools {
    ready: Result<(), String>,
    build_code: i32,
}

impl Tools for FakeTools {
    async fn ready(&self) -> Result<(), String> {
        self.ready.clone()
    }

    async fn build(
        &self,
        args: &[OsString],
        _cancel: &CancellationToken,
        on_line: &mut (dyn FnMut(&str) + Send),
    ) -> std::io::Result<Run> {
        assert_eq!(args[0], "build");
        on_line("Step 1/1 : FROM scratch");
        Ok(Run {
            code: Some(self.build_code),
            tail: Vec::new(),
        })
    }

    async fn save(
        &self,
        image: &str,
        archive: &Path,
        _cancel: &CancellationToken,
    ) -> std::io::Result<()> {
        assert!(image.starts_with("reg/app:"));
        std::fs::write(archive, "fake image bytes")
    }

    async fn remove(&self, _image: &str) {}

    async fn commit_of(&self, _folder: &Path) -> Option<CommitMeta> {
        Some(CommitMeta {
            sha: "b".repeat(40),
            message: "ship it".into(),
        })
    }
}

fn plan(folder: &Path) -> PushPlan {
    PushPlan {
        service_id: SERVICE.into(),
        name: "api".into(),
        folder: folder.to_owned(),
        platform: String::new(),
    }
}

async fn run_push(server: &MockServer, tools: FakeTools) -> (push_local::PushEnd, Vec<PushEvent>) {
    let client = ApiClient::new(
        reqwest::Client::new(),
        InstanceUrl::parse(&server.uri()).unwrap(),
        ApiKey::parse(KEY).unwrap(),
    );
    let events: Arc<Mutex<Vec<PushEvent>>> = Arc::default();
    let sink = Arc::clone(&events);
    let folder = tempfile::tempdir().unwrap();
    let end = push_local::push(
        &client,
        &tools,
        &plan(folder.path()),
        move |event| sink.lock().unwrap().push(event),
        &CancellationToken::new(),
    )
    .await;
    let events = events.lock().unwrap().clone();
    (end, events)
}

fn text_of(events: &[PushEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            PushEvent::Line { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn pushes_builds_uploads_and_follows_to_the_end() {
    let server = MockServer::start().await;
    let image = format!("/api/v1/deploy/services/{SERVICE}/image");
    Mock::given(method("GET"))
        .and(path(image.as_str()))
        .and(header("authorization", format!("Bearer {KEY}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "repository": "reg/app" })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(image.as_str()))
        .and(header("authorization", format!("Bearer {KEY}").as_str()))
        .and(header("content-type", "application/gzip"))
        .and(header("x-polaris-commit", "b".repeat(40).as_str()))
        .and(header("x-polaris-message", "ship%20it"))
        .and(body_string("fake image bytes"))
        .respond_with(ResponseTemplate::new(202).set_body_json(json!({ "deploymentId": "dep_1" })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(path("/api/v1/deploy/deployments/dep_1"))
        .and(query_param("follow", "1"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_string("building\nlisten :3000"))
        .mount(&server)
        .await;
    Mock::given(path("/api/v1/deploy/deployments/dep_1"))
        .and(query_param("tail", "1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "status": "running", "done": true })),
        )
        .mount(&server)
        .await;
    let (end, events) = run_push(
        &server,
        FakeTools {
            ready: Ok(()),
            build_code: 0,
        },
    )
    .await;
    assert!(end.ok, "{end:?}");
    assert_eq!(end.message, "api is serving the new release.");
    assert_eq!(end.phase, PushPhase::Done);
    assert_eq!(
        end.deployment
            .as_ref()
            .map(|(id, outcome)| (id.as_str(), outcome.title.as_str())),
        Some(("dep_1", "Deployed api"))
    );
    let text = text_of(&events);
    for line in [
        "$ docker build -t reg/app:",
        "Step 1/1 : FROM scratch",
        "Sending 16 B...",
        "Deployment dep_1 started.",
        "building",
        "listen :3000",
    ] {
        assert!(text.contains(line), "{line} not in {text}");
    }
    let phases: Vec<PushPhase> = events
        .iter()
        .filter_map(|event| match event {
            PushEvent::State { phase } => Some(*phase),
            _ => None,
        })
        .collect();
    assert_eq!(
        phases,
        [
            PushPhase::Checking,
            PushPhase::Building,
            PushPhase::Saving,
            PushPhase::Sending,
            PushPhase::Deploying,
            PushPhase::Done
        ]
    );
    assert!(events.iter().any(|event| matches!(
        event,
        PushEvent::Progress {
            sent: 16,
            total: 16
        }
    )));
    assert!(matches!(
        events.last(),
        Some(PushEvent::Result { ok: true, .. })
    ));
}

#[tokio::test]
async fn a_refused_key_and_a_failed_build_stop_the_push() {
    let server = MockServer::start().await;
    Mock::given(path(
        format!("/api/v1/deploy/services/{SERVICE}/image").as_str(),
    ))
    .respond_with(ResponseTemplate::new(401))
    .mount(&server)
    .await;
    let (end, _) = run_push(
        &server,
        FakeTools {
            ready: Ok(()),
            build_code: 0,
        },
    )
    .await;
    assert_eq!(
        (end.ok, end.key_refused, end.message.as_str()),
        (false, true, KEY_REFUSED)
    );

    let (end, _) = run_push(
        &server,
        FakeTools {
            ready: Err("Docker did not answer in time. Check that it is running.".into()),
            build_code: 0,
        },
    )
    .await;
    assert_eq!(
        (end.ok, end.key_refused, end.phase),
        (false, false, PushPhase::Failed)
    );
    assert_eq!(
        end.message,
        "Docker did not answer in time. Check that it is running."
    );

    server.reset().await;
    Mock::given(path(
        format!("/api/v1/deploy/services/{SERVICE}/image").as_str(),
    ))
    .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "repository": "reg/app" })))
    .mount(&server)
    .await;
    let (end, _) = run_push(
        &server,
        FakeTools {
            ready: Ok(()),
            build_code: 1,
        },
    )
    .await;
    assert_eq!(end.message, "The build failed. The lines above say why.");
}
