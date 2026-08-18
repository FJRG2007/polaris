# Polaris

Repo-wide constraints that change how a feature has to be built here. Style and
general engineering rules live elsewhere; this file is only the things that are
specific to this project and that are expensive to rediscover.

## The user never touches a terminal

Polaris is installed with one script and run from its interface. After that
install, **the command line is not a requirement for anything** - not updating,
not enabling a feature, not repairing one. The person running it does not open
`.env`, does not edit a file in the checkout, and does not read a container's
logs. Assume they cannot.

So:

- **No screen may ask for a command, a file edit, or a log.** Not "set X in
  `.env`", not "re-run the installer", not "check the such-and-such container".
  If Polaris can do the thing, it does it; if it cannot, the screen says what is
  wrong in terms of what the reader can see, and offers the button that fixes it.
- **A feature is not shipped until it works with no setup.** Anything that needs
  a value only a script can write is switched off everywhere and cannot be
  switched on.
- The exception is what genuinely is not Polaris's to do - a rule in the
  operator's own router, a DNS record at their registrar. Those are named
  precisely, with the values to type, and checked from here so the screen can say
  when they start working.

## How a deployment actually gets your change

**An installed Polaris is only ever updated from the Update button in Settings.**
The operator does not re-run `install.sh`, and does not run `update.sh` by hand.
Assume they never will.

That button reaches the updater script only in the **full** edition: the
dashboard asks hostd for `/v1/update`, hostd runs `POLARIS_HOSTD_UPDATE_CMD` (a
throwaway `polaris-updater` container that runs `sh scripts/update.sh`), and that
script is what calls `reconcile_env` to add new keys to `.env`. In the **limited**
edition there is no hostd, the command is empty, `/v1/update` answers 501, and
**`.env` is never reconciled at all**. The command also has the host repo path
baked in at install time, so an install predating that has an empty one.

It follows that:

- **A feature must work with the environment an existing install already has.**
  Anything that only works once a new variable appears in `.env` is a feature that
  is switched off on every deployment in the world, and the operator has no way to
  switch it on that you have told them about.
- **Every new setting needs a working default in code**, not only in
  `.env.example`. `.env.example` is documentation and a seed for fresh installs;
  it is not a delivery mechanism.
- **A secret two containers share must not travel through `.env`.** Put it on a
  volume both mount and have the dashboard write it at startup, so it exists on
  first boot and repairs itself on every boot after.
- If a screen has to explain that something is missing, it names the update or the
  command that fixes it. It never tells the operator to go and configure
  something Polaris was supposed to set up for them.

## The edge

Traefik ranks routers by **the length of the rule** unless a priority says
otherwise, and the dashboard's own host rule is long enough to outrank every path
router in the deployment. **Give every router an explicit `priority`.** The
ordering in use: 110 guarded call path, 100 path prefixes with no host of their
own (`/api/deploy/ws`, `/livekit`), 50 the dashboard's public hostnames, 10 the
compose-label catch-all.

One malformed file in Traefik's dynamic directory freezes the whole edge on its
last good configuration, silently. Generated route files are rendered by a pure
function so they can be asserted in a test.

## This machine

Docker is not available on the development machine and must never be started
there. Verify against a production build (`npm run build`), the test suite, and -
where a container's behaviour is what is in question - say plainly that it has not
been exercised rather than implying it has.
