//! Push from local: build a service here with this computer's Docker and deploy
//! the image, the way `polaris deploy --local` does. Mirrors the pipeline of
//! `desktop/src/main/push-local.ts`; the window around it is the shell's.
//!
//! The same route and steps as the CLI's `deploy_local`: ask the service for the
//! repository to tag under, `docker build` with a fresh tag, `docker save`
//! gzipped to a private temporary file, send it to
//! `POST /api/v1/deploy/services/:id/image`, and follow the deployment it starts.
//! The image tag is removed afterwards; the layers stay in the build cache.
//!
//! Memory stays bounded however large the build: the archive is compressed and
//! uploaded in chunks, a log line is let out at `docker::MAX_LINE` at the latest,
//! and lines are handed on in batches that are flushed every 100 ms or sooner
//! when many are waiting.

use crate::api::{self, ApiClient, ApiError, DeploymentState, Started};
use crate::deploy_outcome::{deploy_outcome, Outcome};
use crate::docker::{self, build_args, Lines, Run};
use crate::zip_rules::format_bytes;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, ReadBuf};
use tokio_util::sync::CancellationToken;

/// The platforms a push may build for; empty is Docker's own default.
pub const PUSH_PLATFORMS: [&str; 3] = ["", "linux/amd64", "linux/arm64"];

/// How many times the build log's follow is reopened before giving up on it.
/// Polaris ends one follow after 30 minutes, so this is ten hours of build.
pub const MAX_FOLLOWS: usize = 20;

/// Lines waiting to be handed on before they are sent without waiting for the tick.
const MAX_BATCH: usize = 500;
const FLUSH_EVERY: Duration = Duration::from_millis(100);
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PushPhase {
    Ready,
    Checking,
    Building,
    Saving,
    Sending,
    Deploying,
    Done,
    Failed,
    Cancelled,
}

impl PushPhase {
    /// Building or sending, so quitting should ask first.
    pub fn running(self) -> bool {
        matches!(
            self,
            Self::Checking | Self::Building | Self::Saving | Self::Sending
        )
    }
}

/// What the push page is told as it goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PushEvent {
    State { phase: PushPhase },
    Line { text: String },
    Progress { sent: u64, total: u64 },
    Result { ok: bool, message: String },
}

/// What to build and where to send it.
#[derive(Debug, Clone)]
pub struct PushPlan {
    pub service_id: String,
    pub name: String,
    pub folder: PathBuf,
    pub platform: String,
}

/// How a push ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushEnd {
    pub ok: bool,
    pub message: String,
    pub phase: PushPhase,
    /// The finished deployment and its notice, when it was followed to the end.
    pub deployment: Option<(String, Outcome)>,
    /// The key was refused, so the shell forgets it.
    pub key_refused: bool,
}

/// The commit a folder is at, when it is a git checkout - what the CLI sends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitMeta {
    pub sha: String,
    pub message: String,
}

/// The programs a push runs. `SystemTools` is this computer's Docker and git;
/// the tests use fakes.
#[allow(async_fn_in_trait)]
pub trait Tools {
    async fn ready(&self) -> Result<(), String>;
    async fn build(
        &self,
        args: &[OsString],
        cancel: &CancellationToken,
        on_line: &mut (dyn FnMut(&str) + Send),
    ) -> io::Result<Run>;
    /// `docker save <image> | gzip -1 > archive`.
    async fn save(&self, image: &str, archive: &Path, cancel: &CancellationToken)
        -> io::Result<()>;
    async fn remove(&self, image: &str);
    async fn commit_of(&self, folder: &Path) -> Option<CommitMeta>;
}

/// This computer's `docker` and `git`, started with argument lists only.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemTools;

fn os_args(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

impl Tools for SystemTools {
    async fn ready(&self) -> Result<(), String> {
        docker::docker_ready("docker").await
    }

    async fn build(
        &self,
        args: &[OsString],
        cancel: &CancellationToken,
        on_line: &mut (dyn FnMut(&str) + Send),
    ) -> io::Result<Run> {
        docker::run("docker", args, None, cancel, on_line).await
    }

    async fn save(
        &self,
        image: &str,
        archive: &Path,
        cancel: &CancellationToken,
    ) -> io::Result<()> {
        save_image("docker", &os_args(&["save", image]), archive, cancel).await
    }

    async fn remove(&self, image: &str) {
        let _ = docker::run(
            "docker",
            &os_args(&["image", "rm", image]),
            None,
            &CancellationToken::new(),
            |_| {},
        )
        .await;
    }

    async fn commit_of(&self, folder: &Path) -> Option<CommitMeta> {
        let never = CancellationToken::new();
        let git = |tail: &[&str]| {
            let mut args = vec![OsString::from("-C"), folder.as_os_str().to_owned()];
            args.extend(tail.iter().map(OsString::from));
            args
        };
        let sha = docker::run(
            "git",
            &git(&["rev-parse", "--verify", "HEAD"]),
            None,
            &never,
            |_| {},
        )
        .await
        .ok()?;
        let message = docker::run(
            "git",
            &git(&["log", "-1", "--pretty=%s"]),
            None,
            &never,
            |_| {},
        )
        .await
        .ok()?;
        commit_meta(&sha, &message)
    }
}

/// The commit from `git rev-parse` and `git log` runs, as the Electron app reads them.
pub fn commit_meta(sha: &Run, message: &Run) -> Option<CommitMeta> {
    let head = sha.tail.last().map_or("", |line| line.trim());
    let valid = (40..=64).contains(&head.len())
        && head.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if sha.code != Some(0) || !valid {
        return None;
    }
    let said = if message.code == Some(0) {
        message.tail.last().cloned().unwrap_or_default()
    } else {
        String::new()
    };
    let units: Vec<u16> = said.encode_utf16().collect();
    Some(CommitMeta {
        sha: head.to_owned(),
        message: String::from_utf16_lossy(&units[..units.len().min(400)]),
    })
}

/// Runs `program args`, gzips (level 1) what it prints into `archive`, readable by
/// this user only. Streamed: one chunk at a time is held.
pub async fn save_image(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[OsString],
    archive: &Path,
    cancel: &CancellationToken,
) -> io::Result<()> {
    let mut child = docker::command(program, args).spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("no output"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("no error output"))?;
    let said = tokio::spawn(async move {
        let mut said: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 4096];
        while let Ok(count) = stderr.read(&mut buffer).await {
            if count == 0 {
                break;
            }
            said.extend_from_slice(&buffer[..count]);
            if said.len() > 2000 {
                said.drain(..said.len() - 2000);
            }
        }
        String::from_utf8_lossy(&said).into_owned()
    });
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(archive).await?;
    let mut gzip = GzEncoder::new(Vec::new(), flate2::Compression::new(1));
    let mut buffer = vec![0u8; 256 * 1024];
    let copied: io::Result<()> = async {
        loop {
            let count = tokio::select! {
                () = cancel.cancelled() => return Err(io::Error::new(io::ErrorKind::Interrupted, "canceled")),
                read = stdout.read(&mut buffer) => read?,
            };
            if count == 0 {
                break;
            }
            gzip.write_all(&buffer[..count])?;
            file.write_all(gzip.get_ref()).await?;
            gzip.get_mut().clear();
        }
        file.write_all(&gzip.finish()?).await?;
        file.flush().await
    }
    .await;
    if let Err(error) = copied {
        let _ = child.kill().await;
        return Err(error);
    }
    let status = child.wait().await?;
    let said = said.await.unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let last = said.trim().rsplit('\n').next().unwrap_or("").to_owned();
    Err(io::Error::other(format!(
        "docker save exited with {}: {last}",
        status
            .code()
            .map_or_else(|| "null".to_owned(), |code| code.to_string())
    )))
}

/// Hands events on, batching lines.
struct Output<F: Fn(PushEvent) + Send + Sync + 'static> {
    sink: Arc<F>,
    lines: Arc<Mutex<Vec<String>>>,
    ticker: tokio::task::JoinHandle<()>,
}

fn drain(lines: &Mutex<Vec<String>>) -> Option<String> {
    let mut held = lines
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if held.is_empty() {
        return None;
    }
    Some(std::mem::take(&mut *held).join("\n"))
}

impl<F: Fn(PushEvent) + Send + Sync + 'static> Output<F> {
    fn new(sink: F) -> Self {
        let sink = Arc::new(sink);
        let lines: Arc<Mutex<Vec<String>>> = Arc::default();
        let (tick_sink, tick_lines) = (Arc::clone(&sink), Arc::clone(&lines));
        let ticker = tokio::spawn(async move {
            let mut every = tokio::time::interval(FLUSH_EVERY);
            loop {
                every.tick().await;
                if let Some(text) = drain(&tick_lines) {
                    tick_sink(PushEvent::Line { text });
                }
            }
        });
        Self {
            sink,
            lines,
            ticker,
        }
    }

    fn line(&self, text: &str) {
        let full = {
            let mut held = self
                .lines
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            held.push(text.to_owned());
            held.len() >= MAX_BATCH
        };
        if full {
            self.flush();
        }
    }

    fn flush(&self) {
        if let Some(text) = drain(&self.lines) {
            (self.sink)(PushEvent::Line { text });
        }
    }

    /// Lines first, so the page reads them before what follows them.
    fn send(&self, event: PushEvent) {
        self.flush();
        (self.sink)(event);
    }
}

impl<F: Fn(PushEvent) + Send + Sync + 'static> Drop for Output<F> {
    fn drop(&mut self) {
        self.ticker.abort();
        self.flush();
    }
}

/// Counts what the network has read of the archive, for the progress bar.
struct Counted<R> {
    inner: R,
    sent: u64,
    total: u64,
    reported: Option<Instant>,
    report: Arc<dyn Fn(u64, u64) + Send + Sync>,
}

impl<R: AsyncRead + Unpin> AsyncRead for Counted<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = polled {
            let read = (buf.filled().len() - before) as u64;
            if read > 0 {
                self.sent += read;
                let due = self.reported.is_none_or(|at| at.elapsed() > PROGRESS_EVERY);
                if due || self.sent == self.total {
                    self.reported = Some(Instant::now());
                    (self.report)(self.sent, self.total);
                }
            }
        }
        polled
    }
}

enum Stop {
    Canceled,
    Api(ApiError),
    Failed(String),
    Unexpected(String),
}

impl From<ApiError> for Stop {
    fn from(error: ApiError) -> Self {
        Self::Api(error)
    }
}

/// A fresh tag: 6 random bytes as hex, like the Electron app.
fn fresh_tag() -> String {
    let mut bytes = [0u8; 6];
    aws_lc_rs::rand::fill(&mut bytes).expect("the system random source is available");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Run one push to the end. `sink` gets every event; `cancel` stops it, and once
/// the deployment is being followed, stopping only stops following.
pub async fn push<T: Tools, F: Fn(PushEvent) + Send + Sync + 'static>(
    client: &ApiClient,
    tools: &T,
    plan: &PushPlan,
    sink: F,
    cancel: &CancellationToken,
) -> PushEnd {
    let out = Output::new(sink);
    let mut phase = PushPhase::Ready;
    let mut deployment: Option<(String, Outcome)> = None;
    let mut scratch: Option<tempfile::TempDir> = None;
    let result = run_push(
        client,
        tools,
        plan,
        &out,
        cancel,
        &mut phase,
        &mut deployment,
        &mut scratch,
    )
    .await;
    if let Some(dir) = scratch {
        let _ = tokio::task::spawn_blocking(move || drop(dir)).await;
    }
    let finish = |ok: bool, message: String, phase: PushPhase, key_refused: bool| {
        out.send(PushEvent::State { phase });
        out.send(PushEvent::Result {
            ok,
            message: message.clone(),
        });
        PushEnd {
            ok,
            message,
            phase,
            deployment: deployment.clone(),
            key_refused,
        }
    };
    match result {
        Ok((ok, message, end)) => finish(ok, message, end, false),
        Err(Stop::Canceled) if phase == PushPhase::Deploying => finish(
            true,
            "Stopped following. The deployment carries on in Polaris.".into(),
            PushPhase::Cancelled,
            false,
        ),
        Err(Stop::Canceled) => finish(false, "Canceled.".into(), PushPhase::Cancelled, false),
        Err(Stop::Failed(message)) => finish(false, message, PushPhase::Failed, false),
        Err(Stop::Api(error)) => {
            let refused = error.status() == 401;
            finish(false, error.to_string(), PushPhase::Failed, refused)
        }
        Err(Stop::Unexpected(cause)) => {
            eprintln!("[push] {cause}");
            finish(
                false,
                "The push stopped on an unexpected error.".into(),
                PushPhase::Failed,
                false,
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_push<T: Tools, F: Fn(PushEvent) + Send + Sync + 'static>(
    client: &ApiClient,
    tools: &T,
    plan: &PushPlan,
    out: &Output<F>,
    cancel: &CancellationToken,
    phase: &mut PushPhase,
    deployment: &mut Option<(String, Outcome)>,
    scratch: &mut Option<tempfile::TempDir>,
) -> Result<(bool, String, PushPhase), Stop> {
    let mut enter = |next: PushPhase| {
        *phase = next;
        out.send(PushEvent::State { phase: next });
    };
    let check = |cancel: &CancellationToken| {
        if cancel.is_cancelled() {
            Err(Stop::Canceled)
        } else {
            Ok(())
        }
    };
    let service_id = api::id(&plan.service_id)?.to_owned();

    enter(PushPhase::Checking);
    let ready = tools.ready().await;
    check(cancel)?;
    ready.map_err(Stop::Failed)?;

    let target = tokio::select! {
        () = cancel.cancelled() => return Err(Stop::Canceled),
        target = client.image_target(&service_id) => target?,
    };
    let image = format!("{}:{}", target.repository, fresh_tag());
    if let Some(words) = client.address_words() {
        out.line(&format!("{words} (the usual address is not answering)."));
    }

    enter(PushPhase::Building);
    let args = build_args(&image, plan.folder.as_os_str(), &plan.platform);
    let shown: Vec<String> = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    out.line(&format!("$ docker {}", shown.join(" ")));
    let built = tools
        .build(&args, cancel, &mut |text| out.line(text))
        .await
        .map_err(|error| {
            if error.kind() == io::ErrorKind::Interrupted {
                Stop::Canceled
            } else {
                Stop::Unexpected(error.to_string())
            }
        })?;
    if built.code != Some(0) {
        return Err(Stop::Failed(
            "The build failed. The lines above say why.".into(),
        ));
    }

    enter(PushPhase::Saving);
    let dir = tempfile::Builder::new()
        .prefix("polaris-push-")
        .tempdir()
        .map_err(|error| Stop::Unexpected(error.to_string()))?;
    let archive = dir.path().join("image.tar.gz");
    *scratch = Some(dir);
    tools
        .save(&image, &archive, cancel)
        .await
        .map_err(|error| {
            if cancel.is_cancelled() {
                Stop::Canceled
            } else {
                Stop::Unexpected(error.to_string())
            }
        })?;
    tools.remove(&image).await;
    check(cancel)?;

    enter(PushPhase::Sending);
    let meta = tools.commit_of(&plan.folder).await;
    let deployment_id = upload(client, &service_id, &archive, meta, out, cancel).await?;

    enter(PushPhase::Deploying);
    out.line(&format!("Deployment {deployment_id} started."));
    let Some(last) = follow(client, &deployment_id, out, cancel).await? else {
        return Ok((
            true,
            "Still deploying after hours of following. It carries on in Polaris.".into(),
            PushPhase::Cancelled,
        ));
    };
    let outcome = deploy_outcome(&plan.name, &last.status, last.error.as_deref());
    let message = if outcome.ok {
        outcome.body.clone()
    } else {
        format!("{}. {}", outcome.title, outcome.body)
    };
    let (ok, end) = (
        outcome.ok,
        if outcome.ok {
            PushPhase::Done
        } else {
            PushPhase::Failed
        },
    );
    *deployment = Some((deployment_id, outcome));
    Ok((ok, message, end))
}

/// Send the archive, answering the deployment it started.
async fn upload<F: Fn(PushEvent) + Send + Sync + 'static>(
    client: &ApiClient,
    service_id: &str,
    archive: &Path,
    meta: Option<CommitMeta>,
    out: &Output<F>,
    cancel: &CancellationToken,
) -> Result<String, Stop> {
    let file = tokio::fs::File::open(archive)
        .await
        .map_err(|error| Stop::Unexpected(error.to_string()))?;
    let total = file
        .metadata()
        .await
        .map_err(|error| Stop::Unexpected(error.to_string()))?
        .len();
    let sink = Arc::clone(&out.sink);
    let body = Counted {
        inner: file,
        sent: 0,
        total,
        reported: None,
        report: Arc::new(move |sent, total| sink(PushEvent::Progress { sent, total })),
    };
    let message = meta
        .as_ref()
        .map(|meta| encode_uri_component(&meta.message));
    let mut headers: Vec<(&str, &str)> = vec![("content-type", "application/gzip")];
    if let (Some(meta), Some(message)) = (&meta, &message) {
        headers.push(("x-polaris-commit", &meta.sha));
        headers.push(("x-polaris-message", message));
    }
    out.line(&format!("Sending {}...", format_bytes(total)));
    let segments = ["api", "v1", "deploy", "services", service_id, "image"];
    let answer = tokio::select! {
        () = cancel.cancelled() => return Err(Stop::Canceled),
        answer = client.send_file(&segments, body, &headers) => answer?,
    };
    let started: Option<Started> = serde_json::from_value(answer).ok();
    match started {
        Some(started) if api::id(&started.deployment_id).is_ok() => Ok(started.deployment_id),
        _ => Err(Stop::Api(ApiError::Refused {
            status: 202,
            message: "Polaris took the image but did not say which deployment it started.".into(),
        })),
    }
}

/// Print the deployment's build log as it is written, until it finishes, and
/// answer where it ended - or `None` when it was still running after every follow.
async fn follow<F: Fn(PushEvent) + Send + Sync + 'static>(
    client: &ApiClient,
    deployment_id: &str,
    out: &Output<F>,
    cancel: &CancellationToken,
) -> Result<Option<DeploymentState>, Stop> {
    let mut offset: u64 = 0;
    // The log is split on line feeds only, as the Electron app splits it.
    let mut lines = Lines::newline_only();
    let segments = ["api", "v1", "deploy", "deployments", deployment_id];
    for _ in 0..MAX_FOLLOWS {
        let at = offset.to_string();
        let query = [("follow", "1"), ("offset", at.as_str())];
        let mut response = tokio::select! {
            () = cancel.cancelled() => return Err(Stop::Canceled),
            response = client.call(reqwest::Method::GET, &segments, &query) => response?,
        };
        loop {
            let chunk = tokio::select! {
                () = cancel.cancelled() => return Err(Stop::Canceled),
                chunk = response.chunk() => chunk,
            };
            // A follow that broke off is picked up again at the byte it reached.
            let Ok(Some(chunk)) = chunk else { break };
            offset += chunk.len() as u64;
            lines.push(&chunk, |text| out.line(&text));
        }
        let state: DeploymentState = tokio::select! {
            () = cancel.cancelled() => return Err(Stop::Canceled),
            state = client.deployment_state(deployment_id) => state?,
        };
        if state.done {
            lines.finish(|text| out.line(&text));
            return Ok(Some(state));
        }
    }
    lines.finish(|text| out.line(&text));
    Ok(None)
}

/// Whether `platform` is one a push may build for.
pub fn is_platform(platform: &str) -> bool {
    PUSH_PLATFORMS.contains(&platform)
}

/// `encodeURIComponent`, for the commit message header.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
