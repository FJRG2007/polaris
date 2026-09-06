# Calls joined and carried no sound

**Found:** September 2026. **Fixed in:** `dashboard/docker/docker-compose.yml`,
the `rtc.ips.excludes` block on the call server.
**Guarded by:** `apps/web/test/chat/call-candidate-addresses.test.ts`.

## What was seen

Two people in a call, both names on screen, both microphones open, and no audio
in either direction. Calls between two devices in the same house worked
perfectly. It had worked for everybody, from anywhere, for weeks, and then
stopped without anything being changed.

Every screen Polaris draws said the call was healthy: the call server was
connected, the microphone was being sent, the ports page had a tick against the
TCP media port. The only red line was "What you are being sent - nothing is
being sent", which is the symptom, not the cause.

## What it actually was

The call server was handing out **seven addresses** to be reached on, and five
of them were container bridges - the addresses Docker gives itself, which
nothing outside a container on that machine can reach:

```
using external IPs {"ips": [
  "192.168.1.10/192.168.1.10",
  "192.168.1.11/192.168.1.11",
  "172.19.0.1/172.19.0.1",
  "172.18.0.1/172.18.0.1",
  "172.21.0.1/172.21.0.1",
  "203.0.113.10/172.20.0.1"      <- the public address, bound to a bridge
]}
```

A browser is given that list and works through it. A list that is mostly dead
ends is a call that takes too long to find the live address, or nominates a dead
one and sits on it. On the last failing call, of the two people who joined:

- one settled on `172.18.0.1`, and
- **the other never completed the connection at all** and gave up after fifteen
  seconds.

## Why it was intermittent, which is the part that cost the time

Look at the last entry above. The **public** address was attached to
`172.20.0.1` - a bridge.

The server learns its public address by asking a STUN server from every local
interface at once, keeping the first answer and discarding the rest as
duplicates. Which local address the public one ends up attached to is therefore
a race between goroutines, settled anew **on every restart**. Two boots of the
same unchanged configuration on the same machine:

| Boot | Public address attached to |
| --- | --- |
| August | the real network interface |
| September | a container bridge |

Nothing was changed between them. That is the whole of "it worked for days and
then stopped for no reason", and it is why nobody looked at the configuration:
configuration that has not been edited is not where anybody looks.

## The comment that made it worse

The configuration carried a note, written when the bridges were first noticed,
saying they were named where they could be and that the rest

> cost a few wasted checks and nothing else.

That was an assumption stated as a fact, and it sent every later reader past the
real cause. A comment that asserts a consequence has to be a comment somebody
measured.

## What the symptom pointed at instead

Both the Chat diagnosis and the Call ports page said the sound needed two
forwarded ports, and the diagnosis opened with

> the two of you are on different networks and the sound has no way through.

A guess, dressed as a diagnosis. It was false: the ports were correct the whole
time, and the operator spent days on a router that had nothing wrong with it.

Measured from a host on a different network entirely:

- an unsolicited UDP packet to the media port: **zero arrive**, so that port is
  genuinely not forwarded;
- a real client from that same outside host: **joins and publishes**, over UDP,
  selecting the machine's real address.

Both are true at once because the server reaches out first and the reply comes
back the way it went - the same thing every consumer voice application relies
on. **Neither port has to be forwarded for the ordinary case.** They are a
fallback for networks where that does not hold.

## The fix

Exclude those addresses by **address**, not by name. `docker0` and `virbr0` can
be named; a network created for a project is `br-` and a hash, and there is
nothing to write down - which is why the previous attempt only excluded two of
them.

```yaml
rtc:
  ips:
    excludes:
      - 172.17.0.0/16   # docker0
      - 172.18.0.0/15   # and every network Docker creates after it,
      - 172.20.0.0/14   # written as four blocks rather than 172.16/12
      - 172.24.0.0/13   # so that 172.16.0.0/16 is left alone
      - 192.168.122.0/24  # libvirt
      - 169.254.0.0/16    # what a machine calls itself when DHCP failed
```

`172.16.0.0/16` is deliberately left in: Docker does not allocate from it and an
office network occasionally sits there, and hiding a real network from the call
server is the opposite failure and a worse one - two people in the same room
would have their call sent out to the router and back, on a router that will
usually not do it.

Verified on the machine it was found on: the list went from seven addresses,
five of them bridges, to two real interfaces, with the public address on the one
carrying the default route. An outside client joined and published over UDP.

## What stops it coming back

- `call-candidate-addresses.test.ts` reads the compose file and asserts that
  every address a container network hands out is excluded, and that every
  address somebody might actually be called on is not.
- The Chat diagnosis no longer names a cause. It names the one screen that
  measures rather than guesses, and stops there.
- The Call ports page no longer says calls from outside need the ports
  forwarded.

## The general rule

A screen that guesses at a cause is worse than a screen that reports a symptom,
because the guess is what the reader acts on. If Polaris cannot measure why
something failed, it says what failed and where to look - never why.
