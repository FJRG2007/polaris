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
- **Updates.** A Launcher settings row shows the installed version and the newest on the instance
  (`/api/tv/update`), with Update now; Home checks once a day and only shows a notice. An "Update" on
  `/account/tv` reaches the TV as `updateRequest` on its next `/api/tv/state` poll, which carries the TV's
  `versionName`/`versionCode`, and runs the same flow. `SelfUpdate` downloads the APK from the instance
  (resumed with `Range`, waiting out `Retry-After`), checks its SHA-256 and version code, never installs an
  equal or older build, installs through `PackageInstaller`, and reports each step to `/api/tv/update/report`.
  On Android 12+ the install asks nobody when the app updates itself; otherwise the TV shows the system
  confirm and Polaris says "Confirm on the TV". The desktop installer stays the way to install a TV whose
  launcher is too old for this.
