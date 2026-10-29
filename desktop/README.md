# Polaris desktop

Polaris for Windows, macOS and Linux. It opens one Polaris instance in its own
window and adds what a browser tab cannot do:

- **Notices from the system** for calls, messages, mail and finished deploys.
- **Upload a folder** zipped straight from the disk, skipping `node_modules` and
  `.git` without reading them.
- **Push from this computer**: build a service with the local Docker and deploy
  the image, the way `polaris deploy --local` does, with the build and deploy log
  in a window of its own.
- **Follow logs** of a service in a separate window.
- **What you are playing** beside your name in Polaris: the app looks at the
  programs running on this computer every fifteen seconds and matches them
  against the games it knows (`src/main/known-games.ts`) and the ones you added
  yourself under Account > Privacy. Only the matched game's name, its program
  and when it started are sent; Polaris shows it only while game sharing is
  switched on there, and keeps nothing of it while it is off.

Nothing of Polaris runs here: the app is a client of the instance it is pointed
at. The installable web app (Account > Preferences) stays the option with
nothing to download.

## Using it

The first run asks for the address you open Polaris at: https://, or http:// for
an address only your own network reaches (a private IP, a name with no dot, or
one ending in `.local`, `.lan`, `.home.arpa` or `.internal`). Every address
opened is kept under File > Servers, where each one can be named, opened or
removed, and File > Switch to goes straight to another; each server keeps its
own sign-in and its own saved API key. Pushing asks once
for an API key with the Deploy scope (Account > API keys); the key is encrypted
by the operating system's password store (Keychain, Windows DPAPI, or the
desktop's secret service on Linux) and never written in plain text. On a Linux
desktop with no secret service, it is kept only until the app quits.

The window only ever loads the instance's own address, with one exception:
connecting an outside account, or signing in with one, goes through the
provider's pages in the window, since that is where the sign-in it started
lives. File > Back returns to Polaris from a provider's page. Any other address
opens in the system browser.

Sharing your screen in a call opens a picker with a picture of every screen and
window (on Windows, with a switch for the computer's sound); macOS shows its own.
When you let somebody in the call draw on a shared screen, their strokes also
appear on that display, in a window that takes no clicks and, on Windows 10 2004
and later and macOS, stays out of the share itself. A shared window, rather than
a whole screen, and a share picked in macOS's own picker are drawn on only for
the others, and the request to draw says so.

When a newer version is released, it is downloaded and installed in the
background and opens the next time the app starts; a notice and the Help menu
offer to restart into it now. That is the Windows installer, a macOS app signed
with a Developer ID, and the AppImage, which is replaced only once the download
matches the release's `SHA256SUMS`. For the .deb, an unsigned Mac app, or when
an update fails, a notice says so and the Help menu offers its download page.

On Linux systems that forbid unprivileged user namespaces (Ubuntu 24.04 and
later by default), the .deb uses Chromium's setuid sandbox helper instead. The
AppImage cannot, so on those systems, and only there, it starts without the
sandbox.

## Developing

```sh
npm ci
npm run typecheck
npm test
npm start           # build and run it
npm run make        # installers for this platform, in out/make
```

Packaging needs **Node 22**: the packager's zip extractor stops silently on
newer Node and reports success with nothing built. Tests and the bundle work on
any Node from 22.12.

`npm run icons` redraws `assets/` from the Polaris mark with Electron itself;
the results are committed.

## Releases

Push a tag `desktop-v<version>` matching `version` in `package.json`.
`.github/workflows/desktop.yml` builds the Windows installer (Squirrel), macOS
`.dmg` and `.zip` for arm64 and x64, and a Linux `.deb` and AppImage, and
attaches them to the tag's release, with what self-update reads: a
`RELEASES-darwin-<arch>.json` feed per Mac architecture (`build/mac-feed.cjs`)
and a `SHA256SUMS` of every file. It can also be run by hand, which keeps the
installers as workflow artifacts.

Builds are unsigned unless these repository secrets exist. They are only used on
a `desktop-v*` tag or on `main`; a run by hand from another branch is unsigned.

| Secret | Used for |
| --- | --- |
| `SIGNPATH_API_TOKEN` | Windows through SignPath (below); with it, the certificate file is not used |
| `WINDOWS_CERTIFICATE_BASE64` | The code-signing certificate (`.pfx`), base64-encoded |
| `WINDOWS_CERTIFICATE_PASSWORD` | Its password |
| `APPLE_CERTIFICATE_BASE64` | The Developer ID Application certificate (`.p12`), base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | Its password |
| `APPLE_SIGNING_IDENTITY` | The identity to sign with, as `security find-identity` prints it |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization; skipped unless all three are set |

An unsigned macOS app has to be opened with right-click > Open the first time,
and Windows SmartScreen warns about an unsigned installer. A Mac app updates
itself only when it is signed with a Developer ID: Squirrel.Mac checks each
update against the running app's signature.

### Windows signing through SignPath

Windows can be signed by the [SignPath Foundation](https://signpath.org) program
for open-source projects instead of a certificate of our own. It is used once
the secret above and these repository **variables** (Settings > Secrets and
variables > Actions > Variables) exist, all copied from the SignPath project:

| Variable | Value |
| --- | --- |
| `SIGNPATH_ORGANIZATION_ID` | The organization ID |
| `SIGNPATH_PROJECT_SLUG` | The project's slug |
| `SIGNPATH_SIGNING_POLICY_SLUG` | The signing policy's slug |

The SignPath GitHub App has to be installed on the repository, and the project
linked to it as a trusted build system. The project's default artifact
configuration must be this one, since the workflow sends two zips through it:
the packaged app, then the installer made from it.

```xml
<?xml version="1.0" encoding="utf-8"?>
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="polaris.exe" min-matches="0">
      <authenticode-sign/>
    </pe-file>
    <pe-file path="Polaris-Setup.exe" min-matches="0">
      <authenticode-sign/>
    </pe-file>
  </zip-file>
</artifact-configuration>
```

Squirrel puts the app into the installer, so the app is signed first, the
installer and update package are made from the signed app, and the installer is
signed last; the workflow fails if either comes back without a valid signature.
Squirrel's own `Update.exe` and the small launcher it puts in front of
`polaris.exe` are upstream binaries, which SignPath Foundation does not sign, so
they stay unsigned; SmartScreen judges the downloaded installer, which is signed.
Each release asks an approver in SignPath twice, and the Windows build waits for
both.

SignPath Foundation requires the project to publish [CODE_SIGNING.md](CODE_SIGNING.md),
linked as "Code signing policy" from the repository's home page and from the
release notes, with this attribution:

> Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org)

## Dependencies

The app ships two runtime dependencies, bundled into it: `zod` and `fflate`.
CI fails on a high advisory in those. `npm audit` also reports advisories in the
packaging tools (`tar`, `extract-zip`, `tmp`, `image-size` under electron-forge
7.11.2, the latest release); they run only on the build machine, against
Electron's own archives and this app's files, and none of them is in the app.
