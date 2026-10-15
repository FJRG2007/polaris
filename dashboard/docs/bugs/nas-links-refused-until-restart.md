# A NAS mounted before links were turned on refused them until a restart

**Found:** October 2026. **Fixed in:** `crates/polaris-hostd/src/handlers.rs`,
`dashboard/apps/web/src/lib/deploy/ports-ssh.ts`,
`dashboard/apps/web/src/lib/storage-service.ts`,
`dashboard/apps/game-servers/messages/{en-US,es-ES}/games.json`,
`dashboard/apps/web/messages/{en-US,es-ES}/admin.json`.
**Guarded by:** `crates/polaris-hostd/src/handlers.rs` (unit test, below),
`dashboard/apps/web/test/deploy/ssh-mount-flags.test.ts`.

## What was seen

Moving a game server's world to a NAS share failed with "The NAS couldn't
store the link `Game.ini`, so nothing was copied" - on a share that worked
for everything else. The message told the operator the fix was a restart of
the machine running Polaris, and a restart did fix it, but there was no
terminal step in between: the share had been reachable and writable the
whole time.

## What it actually was

`mfsymlinks` is the SMB mount option that lets a client store a symbolic link
on a share whose server does not create real links for SMB clients; without
it the server answers "Not supported" on every link. The option is asked for
by `MountSpec`/`SMB_OPTS` in `storage-service.ts`, but a kernel mount only
takes the options it is given **at mount time** - a share mounted before
`mfsymlinks` existed, or before this connection carried it, kept running with
the options it already had. Nothing ever mounted it again while it answered:
both mount paths (`run_mount` in the host daemon, `ensureMount` in
`ports-ssh.ts` for a server reached over SSH) treat a live, readable mount
point as already satisfying the request and return immediately. The only
event that remounted every share with its current options was the daemon, or
the remote machine, starting fresh - hence "restart the machine" actually
working, for a reason nobody had named.

## The fix

Both mount paths now compare what a live mount actually carries against what
was asked for, and remount in place when a flag is missing, instead of only
restarting from a dead mount point:

- **`crates/polaris-hostd/src/handlers.rs`** - `run_mount` calls
  `apply_missing_flags` on a mountpoint that already answers. It reads
  `/proc/self/mountinfo`, lists the per-mount and filesystem-reported options
  for the target (`mountinfo_options`, last line wins for a stacked mount),
  and diffs the bare flags - not valued options, which the kernel often
  prints in another form or not at all - from what was requested
  (`missing_flags`). A real gap re-runs `mount_command` with `-o
  remount,<options>`, which changes the options every container's bind of
  the share sees without detaching it. `first_remount` keys a process-lifetime
  set by `id` and the exact option string, so a flag the kernel accepts but
  never lists back (and would therefore look "still missing" forever) is
  tried once, not on every mount call.
- **`dashboard/apps/web/src/lib/deploy/ports-ssh.ts`** - `ensureMount`'s
  script does the same comparison with `awk` against the remote
  `/proc/self/mountinfo`, and remembers that it already tried a given option
  string in a marker file (`REMOTE_MOUNT_ROOT/.remount-<id>`) rather than a
  daemon-local set, since the SSH session that runs the script does not
  persist between calls the way `polaris-hostd` does.
- A remount the kernel refuses (mode still wrong, option unsupported by the
  server) leaves the mount exactly as it was and is only logged - the share
  keeps working for everything but the missing flag, same as before.
- The `noLinks` error (`games.json`, `admin.json`, both locales) now tells
  the operator to try again first, because trying again is what now fixes
  it, and only falls back to "restart the machine" for the share types this
  remount cannot reach (a flag the kernel refuses, or a mount outside
  Polaris's own two paths).

## What stops it coming back

`a_live_mount_missing_a_requested_flag_is_found` in `handlers.rs` covers
`mountinfo_options` and `missing_flags` against a fixture mount table,
including a stacked mount (reads as the top one) and per-mount options
counting alongside the filesystem's own. `ssh-mount-flags.test.ts` runs
`ensureMount`'s script against a real `sh` with `mount`/`umount` replaced by
stubs that only record their call: it asserts a share missing `mfsymlinks`
is remounted exactly once even across two calls, a share that already has
every flag is left alone, and a remount the stub mount refuses still leaves
the share mounted.

## The general rule

A kernel mount's options are fixed at mount time, not at request time,
so a feature added to a fixed, well-known option string (a new mount flag,
not a path or credential) is invisible to every share that was already up
when it shipped - and nothing short of detaching the share picks it up on
its own, since a live, readable mountpoint is deliberately treated as already
satisfying the next request for it. A request to mount something idempotent
still has to compare what is live against what is now being asked for, and
remount - without detaching what already works - when the two disagree.
