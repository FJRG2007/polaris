# The port-80 forwarder restarted every fifteen seconds forever

**Found:** October 2026. **Fixed in:** `dashboard/packages/deploy/src/private-names.ts`.
**Guarded by:** `packages/deploy/test/private-names.test.ts`.

## What was seen

A service that asked to be reached on port 80 got a sidecar container that
forwarded it there, and that sidecar never settled: it came up, ran for about
fifteen seconds, and restarted - on and on, for as long as the deployment was
up. The service behind it kept answering the whole time, so nothing about the
service itself looked wrong.

## What it actually was

`forwarderScript` builds the sidecar's shell command by joining an array of
statements with a single space. One of them started a background `socat`
listener and captured its pid:

```
socat TCP4-LISTEN:${PORTLESS_PORT},fork,reuseaddr ${target} & pid=$!
```

with no `;` at the end, directly followed by the next statement in the array.
Without a separator, `pid=$!` is not a statement on its own - it is a shell
variable assignment glued onto the front of whatever command comes right
after it, which only lasts for that one command. The shell's own `$pid`, read
later by the watch loop, was never set; it stayed empty for the life of the
script. `kill -0 $pid` against an empty `$pid` fails immediately, so the watch
loop's very first check believed the listener had already died and exited -
which is what the container's restart policy read as a crash, and brought
back in a new namespace fifteen seconds later, to do it again.

## The fix

One semicolon: `& pid=$!;`. That is enough to end the assignment as its own
statement, so `$pid` holds the listener's pid for the rest of the script and
the watch loop has something real to check.

## What stops it coming back

`private-names.test.ts` renders the script and asserts the pid assignment is
followed by its own separator (`/& pid=\$!; /`) and that the watch loop reads
it back (`kill -0 $pid`), so a join that drops the trailing `;` again fails
the test before it reaches a container.

## The general rule

A shell script assembled by joining strings has no statement boundaries of
its own - every element has to carry its own terminator, because the array
that holds them has no idea which of its entries end a line and which don't.
An assignment with no separator after it is not a bug that throws or logs
anything: it is a variable that silently never exists, and the next thing
that reads it fails in a way that points at the read, not at the missing
`;` three lines above it.
