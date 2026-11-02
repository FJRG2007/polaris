# Polaris TV

This folder is the base of Polaris TV: [cleanyourtv](https://github.com/Gathin23/cleanyourtv) by
Gathin, under the MIT licence in [LICENSE](LICENSE), brought in unchanged so that upstream fixes stay
easy to compare. The launcher, add-ons, themes, tools and device lists work on their own, with no
Polaris instance.

It runs on Android TV and Google TV only. Samsung, LG, Roku, Vizio and VIDAA sets run other systems
that cannot take it.

## What differs from upstream

- **Identity.** The package is `app.polaris.tv` and the name is Polaris TV, so it installs beside the
  upstream launcher instead of over it. The rename is mechanical: replacing `app.polaris.tv` with
  `com.gathin.tvhome` gives back upstream's text.
- **An optional Polaris account.** Launcher settings has a Polaris row. Nothing goes on the network until
  somebody connects an instance there, so `INTERNET` is declared but unused on a TV with no account. This
  is the one upstream rule this fork gives up on purpose, and it stays off by default.
- **Connecting.** `PolarisActivity` opens a device grant at `/api/tv/authorize`, shows a code and a QR, and
  stores a key of kind `tv` sealed under the Android Keystore. That key has no scopes: it reads the owner's
  name and notification counts at `/api/tv/state` and nothing else.
- **Local fallback.** `PolarisFailover` is the Java copy of `dashboard/packages/core/src/instance-fallback.ts`.
  An alternate address sees the key only after signing a fresh nonce with the instance's Ed25519 key, which
  `PolarisEd25519` verifies because the platform only has it from API 33. A change to that protocol changes
  both files.
