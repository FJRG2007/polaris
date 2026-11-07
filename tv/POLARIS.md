# Polaris TV

This folder is Polaris TV: the Android TV launcher `app.polaris.tv`, its add-ons, themes, tools and
device lists. They work on their own, with no Polaris instance.

It runs on Android TV and Google TV only. Samsung, LG, Roku, Vizio and VIDAA sets run other systems
that cannot take it.

## What Polaris adds

- **An optional Polaris account.** Launcher settings has a Polaris row. Nothing goes on the network until
  somebody connects an instance there, so `INTERNET` is declared but unused on a TV with no account. It stays
  off by default.
- **Connecting.** `PolarisActivity` opens a device grant at `/api/tv/authorize`, shows a code and a QR, and
  stores a key of kind `tv` sealed under the Android Keystore. That key has no scopes: it reads the owner's
  name and notification counts at `/api/tv/state` and nothing else.
- **Local fallback.** `PolarisFailover` is the Java copy of `dashboard/packages/core/src/instance-fallback.ts`.
  An alternate address sees the key only after signing a fresh nonce with the instance's Ed25519 key, which
  `PolarisEd25519` verifies because the platform only has it from API 33. A change to that protocol changes
  both files.
- **Block ads and trackers.** A Launcher settings row on Android 9+ that points Private DNS at a filtering
  resolver: the Polaris Network filter's hostname from `/api/tv/network-filter` when it publishes one, or any
  hostname typed there. `PrivateDns` saves the TV's own setting first, keeps the new one only when Android
  validates it and a name resolves through it within 30 s, and puts the old one back otherwise, on Off, and
  when Home finds names no longer resolving. It needs `WRITE_SECURE_SETTINGS`, which the desktop installer
  grants only when its "block ads and trackers" box is ticked; the installer's backup keeps the DNS from before.
