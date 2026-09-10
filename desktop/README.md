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

Nothing of Polaris runs here: the app is a client of the instance it is pointed
at. The installable web app (Account > Preferences) stays the option with
nothing to download.

## Using it

The first run asks for the address you open Polaris at: https://, or http:// for
an address only your own network reaches (a private IP, a name with no dot, or
one ending in `.local`, `.lan`, `.home.arpa` or `.internal`). Pushing asks once
for an API key with the Deploy scope (Account > API keys); the key is encrypted
by the operating system's password store (Keychain, Windows DPAPI, or the
desktop's secret service on Linux) and never written in plain text. On a Linux
desktop with no secret service, it is kept only until the app quits.

The window only ever loads the instance's own address, with one exception:
connecting an outside account, or signing in with one, goes through the
provider's pages in the window, since that is where the sign-in it started
lives. File > Back returns to Polaris from a provider's page. Any other address
opens in the system browser.

When a newer version is released, a notice says so and the Help menu offers its
download page.

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
attaches them to the tag's release. It can also be run by hand, which keeps the
installers as workflow artifacts.

Builds are unsigned unless these repository secrets exist. They are only used on
a `desktop-v*` tag or on `main`; a run by hand from another branch is unsigned.

| Secret                                                     | Used for                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `WINDOWS_CERTIFICATE_BASE64`                               | The code-signing certificate (`.pfx`), base64-encoded             |
| `WINDOWS_CERTIFICATE_PASSWORD`                             | Its password                                                      |
| `APPLE_CERTIFICATE_BASE64`                                 | The Developer ID Application certificate (`.p12`), base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD`                               | Its password                                                      |
| `APPLE_SIGNING_IDENTITY`                                   | The identity to sign with, as `security find-identity` prints it  |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization; skipped unless all three are set                    |

An unsigned macOS app has to be opened with right-click > Open the first time,
and Windows SmartScreen warns about an unsigned installer.

## Dependencies

The app ships two runtime dependencies, bundled into it: `zod` and `fflate`.
CI fails on a high advisory in those. `npm audit` also reports advisories in the
packaging tools (`tar`, `extract-zip`, `tmp`, `image-size` under electron-forge
7.11.2, the latest release); they run only on the build machine, against
Electron's own archives and this app's files, and none of them is in the app.
