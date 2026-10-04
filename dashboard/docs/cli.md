# The Polaris CLI (`plr`)

A command-line client for people who use a Polaris, not for the people who run
one. Sign in once from your browser; every command after that uses that
sign-in. Installed as `plr` and as `polaris`.

## Install

Each Polaris serves the CLI that matches it. Copy the line from
**Account > Downloads > Command line**, or:

```sh
# macOS and Linux
curl -fsSL https://your-polaris/cli/install.sh | sh
```

```powershell
# Windows
irm https://your-polaris/cli/install.ps1 | iex
```

It needs Node.js 20 or newer. Nothing needs root or Administrator:

|              | Bundle                                            | Launchers                          |
| ------------ | ------------------------------------------------- | ---------------------------------- |
| macOS, Linux | `~/.local/share/polaris-cli/polaris.mjs`          | `~/.local/bin/plr`, `polaris`      |
| Windows      | `%LOCALAPPDATA%\Programs\polaris-cli\polaris.mjs` | `plr.cmd`, `polaris.cmd` beside it |

`plr update` replaces it with the one your Polaris serves now, after checking
the download against the SHA-256 the server sends with it. `plr uninstall`
signs every profile out, revokes their keys, and removes the CLI.

### Not on a Polaris server

The installer refuses to run on a computer that runs a Polaris server, and the
CLI refuses to start there. The server installs its own management command
under the same two names (`/usr/local/bin/polaris` and `plr`, or
`%LOCALAPPDATA%\Polaris\bin` on Windows), and whichever came first on `PATH`
would silently answer for the other. A server is recognised by its own command
(by its header, not its name), its checkout (`/opt/polaris` or
`%ProgramData%\Polaris`, or `POLARIS_INSTALL_DIR`), its secrets store
(`/var/lib/polaris/secrets.env`), and, at install time only, a running `polaris`
Docker Compose project. Nothing of the server's is read beyond that or changed.

The server's installer checks the other way round: on a fresh install it stops
if the CLI is present and says to run `plr uninstall --yes` first. Updating an
existing server is never blocked; it warns instead.

## Sign in

```sh
plr login --url https://your-polaris
```

It opens `/account/cli` on your Polaris with a code already filled in; check the
code matches and press **Sign it in**. Over SSH, on a machine with no display,
or with `--browserless`, it prints the address and the code to type on any
device instead. The code is good for five minutes.

What you approve is an API key of kind CLI, limited to Deploy (`deploy.read`,
`deploy.manage`, and never more than your account holds), valid for a year.

That key is the sign-in, and it shows in two places that act on the same row:

- **Account > Sessions**, as a session: the computer, its system, the CLI
  version, the address it was approved from, and when and where it was last
  used (recorded at most once a minute, at once when the address changes). Sign
  it out there, lock it to its address like any session, or sign out
  everywhere, which includes every CLI sign-in. An administrator sees and can
  end it in their view of the account.
- **Account > API keys**, with a CLI badge that links to Sessions.

`plr logout` revokes it too. Once it is ended anywhere, the CLI's next command
says it was signed out from Polaris and to run `plr login`.

The key is kept in the system keychain (macOS Keychain, the Windows Credential
Locker, or libsecret on Linux). Where there is none, it goes to
`credentials.json` in the config folder, created readable only by you. The
config folder (`~/.config/polaris-cli`, `~/Library/Application Support/polaris-cli`
or `%APPDATA%\polaris-cli`) holds profiles and no secret.

## Profiles

One profile per Polaris, or per account on one. `plr login --url` adds one named
after the address unless `--profile NAME` names it.

```sh
plr profile list
plr profile use work
plr projects --profile home     # one command, without switching
```

`POLARIS_PROFILE` picks a profile the same way. For CI, `POLARIS_TOKEN` (an API
key with Deploy scopes) and `POLARIS_URL` take the place of a profile.

## Commands

```text
plr whoami                         who you are signed in as, and what you may do
plr status                         CLI version, Polaris, sign-in, update available
plr projects                       every service you can reach
plr service shop/web               status, source, domains
plr deployments shop/web           recent deployments
plr deploy shop/web --follow       deploy again and watch the build
plr build-log DEPLOYMENT --follow
plr logs shop/web --follow --tail 100
plr restart shop/web
plr open [home|deploy|keys|downloads]
```

A service is `project/service` (its default environment),
`project/environment/service`, or its id. Read commands print JSON with
`--json`. Every failure says what to do next; `POLARIS_DEBUG=1` adds the
details of one the CLI did not expect.

A Polaris on a private certificate authority is trusted by pointing
`NODE_EXTRA_CA_CERTS` at the CA's certificate; there is no switch that turns
verification off.
