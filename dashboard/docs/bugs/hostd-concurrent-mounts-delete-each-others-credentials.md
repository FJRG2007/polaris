# Two requests to mount one share deleted each other's credentials

**Found:** October 2026. **Fixed in:** `crates/polaris-hostd/src/handlers.rs`.
**Guarded by:** `crates/polaris-hostd/src/handlers.rs` (unit tests, below).

## What was seen

A share that was otherwise reachable would intermittently fail to mount
with a mount-helper error - "error opening credential file" - on an SMB
target that mounted fine moments before or after. It surfaced most under
load: a wall of avatars loading at once asks the host daemon to mount the
same share once per request, since the dashboard checks on every read
rather than caching that it is already up.

## What it actually was

`run_mount` wrote one SMB share's username and password to a fixed path,
named only after the share id (`/run/polaris/mount-creds-<id>`), then ran
`mount.cifs` against it and deleted the file once `mount.cifs` returned.
Two requests to mount the *same* share arrive on a thread each and run
concurrently, both writing to that one name. The first `mount.cifs` call to
finish deleted the file - as it is supposed to, once its own mount is up -
while the second call's `mount.cifs`, started a moment later, was still
opening it. It read nothing, or read the first call's credentials, or
failed outright, depending on exactly how the two raced.

## The fix

Two changes, independent of each other:

- `mount_creds_path` gives every mount **call** its own file name
  (`mount-creds-<id>-<unique>` via `staged_name`) instead of one name
  shared by every call for that share, so no call's cleanup can remove a
  file another call is still reading.
- `mount_lock`/`mount_delete` take a per-share-id lock before calling
  `run_mount`/`run_umount`, so two requests for the same share no longer
  run `mount` (or `mount` and `umount`) side by side at all - the second
  waits for the first. The lock is keyed by share id specifically so that
  a share whose NAS is switched off, and whose `mount` call is sitting out
  the kernel's own connect retries, does not hold up a deploy mounting a
  *different* share.

## What stops it coming back

Two unit tests in `handlers.rs`:
`concurrent_mounts_of_one_share_never_share_a_credentials_file` asserts two
calls for the same id get different credential paths, and
`one_share_is_mounted_by_one_request_at_a_time` asserts the lock returned
for the same id is the same `Arc`, and the lock for a different id is a
different one (so unrelated shares are not serialized against each other).

## The general rule

A resource named after a shared key - an id, not a per-call token - is a
resource two concurrent callers for that key will collide on the moment
either one's cleanup runs while the other is still using it. Either give
each call its own name under that key, or serialize the calls; this fix
did both, because the credentials file needed its own name regardless (a
mount helper reads a file, it does not take an argument), and the mount
and unmount themselves needed to not run concurrently against the same
kernel target either way.
