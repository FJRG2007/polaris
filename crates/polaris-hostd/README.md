# polaris-hostd

The privileged host daemon for Polaris. It serves the **hostd HTTP API v1** and
lets the dashboard container broker operations it cannot perform from inside its
sandbox: reading and writing host files, and mounting network shares.

## The edition model

Polaris ships as **one image**. What that image can do depends on whether
`polaris-hostd` is running on the host:

- **Sandboxed edition** - the dashboard runs alone in its container. It sees
  only what is bind-mounted into it and cannot touch the host directly.
- **Full edition** - `polaris-hostd` runs on the host (as root) with its Unix
  socket bind-mounted into the dashboard container. The dashboard detects the
  socket, authenticates with the per-run token, and unlocks host filesystem
  access, native mounts, and (later) container/orchestration control.

The daemon is the switch. No separate build, no feature flags in the image -
its presence flips the behaviour.

## Design

Deliberately dependency-light and static-musl friendly, matching the rest of
the Polaris fleet:

- Hand-rolled minimal HTTP/1.1 over `std::os::unix::net::UnixListener` (and
  `std::net::TcpListener` for the fallback). No hyper/axum/actix.
- Only `serde`/`serde_json` are pulled in. The token CSPRNG reads
  `/dev/urandom` directly (no `rand`); the constant-time compare is hand-rolled.
- One request per connection (`Connection: close`), one thread per connection.
- Every input is treated as hostile because the process runs as root.

## Transport and auth

| Variable | Default | Purpose |
|---|---|---|
| `POLARIS_HOSTD_SOCKET` | `/run/polaris/hostd.sock` | Unix socket path (mode 0660). Parent dir is created; a stale socket is unlinked on start. |
| `POLARIS_HOSTD_ADDR` | _(unset)_ | Optional TCP fallback, e.g. `127.0.0.1:16081`. Bound only when set. |
| `POLARIS_HOSTD_TOKEN_FILE` | `/run/polaris/hostd.token` | Where the per-run bearer token is written (mode 0600). |
| `POLARIS_HOSTD_ROOT` | `/` | Allowlist root for `/v1/fs/*`. Paths canonicalizing outside it are rejected. |
| `POLARIS_HOSTD_MOUNT_ROOT` | `/mnt/polaris` | Allowlist root for mount targets. |
| `POLARIS_HOSTD_AUTOUPDATE` | `true` | Set to `false` to report auto-update as unavailable. |

A fresh **256-bit bearer token** is generated on every start and written to the
token file. **Every** request (including `/v1/health`) must carry
`Authorization: Bearer <token>`; the token is compared in **constant time**.
Missing or wrong token -> `401`.

## API v1

All paths are prefixed `/v1`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/health` | `{ version, capabilities: { hostFilesystem, nativeMounts, docker, kubernetes, systemd, autoUpdate } }`. Capabilities are probed from the host on each call. |
| `GET` | `/v1/fs/<path>` | Stream a file. Honours `Range: bytes=start-end` -> `206 Partial Content`. |
| `PUT` | `/v1/fs/<path>` | Write the request body to the file (parent dirs created). Body is streamed to disk. |
| `DELETE` | `/v1/fs/<path>` | Remove the file. |
| `POST` | `/v1/mounts` | Body `{ id, kind: "smb"\|"nfs", source, target, options? }`. Mounts under the mount root. `201` with `{ id, mountpoint }`. |
| `DELETE` | `/v1/mounts/<id>` | Unmount the target created for `<id>`. |
| `POST` | `/v1/update` | Auto-update. **Stub -> `501`** (lands later). |
| `*` | `/v1/docker/*`, `/v1/k8s/*`, `/v1/systemd/*` | Future control planes. **Stubs -> `501`**. |

Unknown route -> `404`. Malformed JSON or failed validation -> `400` with a
safe, generic message (internal error detail is never leaked).

### Security properties

- **Path confinement** - `/v1/fs/*` and mount targets are resolved against their
  allowlist root with two defenses: lexical rejection of `..`/NUL/absolute
  components, then canonicalization of the deepest existing ancestor checked to
  remain under the canonical root (which also defeats symlink escapes). Escapes
  -> `403`.
- **No shell** - `mount`/`umount` are invoked with an **argument vector** via
  `std::process::Command`; no string is ever passed to a shell. Mount fields are
  additionally rejected if they contain shell metacharacters or NUL (defense in
  depth). `kind` selects the `-t` filesystem type, so no client string reaches
  it. Ids are held to an `[A-Za-z0-9_-]` allowlist.
- **Bounded input** - control (JSON) bodies are capped at 16 MiB; the request
  head is capped at 64 KiB; body reads are bounded to `Content-Length`.
- **No secret logging** - the token is never logged.

## Build and run

Native build (for development):

```sh
cargo build -p polaris-hostd
```

Static musl cross-build (production, both server arches):

```sh
crates/polaris-hostd/build/cross-build.sh
# or a single target:
crates/polaris-hostd/build/cross-build.sh x86_64-unknown-linux-musl
```

Install the systemd unit from `build/polaris-hostd.service` (expects the binary
at `/usr/local/bin/polaris-hostd`).

## Platform note (dev shim)

The daemon targets **Linux**. To keep `cargo build`/`clippy`/`test` green on a
Windows dev machine, the Unix-socket transport, the `0600`/`0660` `chmod` calls,
and the `mount`/`umount` execution are guarded with `#[cfg(unix)]`:

- On non-unix, the Unix listener is absent (only the TCP fallback binds, and if
  no `POLARIS_HOSTD_ADDR` is set the daemon exits with a clear message).
- On non-unix, `chmod` is skipped and token bytes come from a **non-cryptographic
  placeholder** instead of `/dev/urandom` - never used in production.
- On non-unix, `run_mount`/`run_umount` return `501`.

All security-critical logic (constant-time compare, path confinement, mount
field validation, JSON parsing) is platform-independent and unit-tested on every
platform.
