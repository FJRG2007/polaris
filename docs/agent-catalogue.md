# Agent catalogue

The coding agents Polar Code can start a session with, compared against the
agents Agent Orchestrator ("AO", github.com/OrchestratorInc/agent-orchestrator,
Apache-2.0) supports. The catalogue lives in
`dashboard/packages/core/src/agent-clis.ts`; this page records where each field
came from and what was left out because it could not be verified.

Every value below was read from AO's source: the binary from the adapter's
binary spec (`backend/internal/adapters/agent/<name>/`), the install command
from its install plan (`backend/internal/service/systeminstall/agentplans.go`),
the credential variables from the adapter's sign-in probe (`auth.go`), the
unattended flags from its full-access permission mode, and the ACP arguments
from its chat driver (`backend/internal/adapters/chatdriver/<name>acp`). Nothing
was taken from memory. A session always signs in with the person's own
credential or the login already on the machine; Polaris proxies no usage.

## How a session starts each one

- Install: the catalogue's `install` line runs once, as the agent's own user,
  when the binary is missing. Script installers drop their binary in
  `~/.local/bin`, which the boot script now puts on `PATH`. A tool whose
  installer needs `uv` gets the "could not be installed" message on a machine
  without it.
- Launch: every tool runs on its own terminal interface. Claude Code is the only
  one that runs one turn at a time (`headless`), because only its flags were
  checked against its documentation.
- ACP: `acp` records the arguments that start the tool as an Agent Client
  Protocol server, as AO's chat driver starts it. Sessions do not use it yet:
  Polar Code has no ACP client. It is catalogue data for when one exists.
- Activity: the agents with hooks (Claude Code, Codex, Gemini CLI, Copilot) report
  each turn. Every other one is read from its output.

## Inventory

Status: **catalogued** is in `agent-clis.ts`; **upgraded** was already there and
took fields from AO; **not catalogued** is explained in the notes.

| Agent | AO adapter | Binary | Install | Launch | Sign-in | AO hooks | Polaris |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `agent/claudecode` | `claude` | npm `@anthropic-ai/claude-code` | TUI, headless | subscription token, `ANTHROPIC_API_KEY` | yes | catalogued, hooks |
| Codex | `agent/codex` | `codex` | npm `@openai/codex` | TUI (AO: app-server) | ChatGPT plan, `OPENAI_API_KEY` | yes | catalogued, hooks |
| OpenCode | `agent/opencode` | `opencode` | npm `opencode-ai` | TUI, ACP `acp` | provider keys | yes | upgraded (ACP) |
| Gemini CLI | `agent/gemini` | `gemini` | npm `@google/gemini-cli` | TUI | Google account, `GEMINI_API_KEY` | yes | catalogued, hooks |
| GitHub Copilot | `agent/copilot` | `copilot` | npm `@github/copilot` | TUI, ACP `--acp` | Copilot plan, `GH_TOKEN` | yes | upgraded (ACP) |
| Cursor | `agent/cursor` | `cursor-agent` | `curl https://cursor.com/install` | TUI, ACP `acp` | `CURSOR_API_KEY` | yes | upgraded (install, ACP) |
| Amp | `agent/amp` | `amp` | npm `@ampcode/cli` | TUI | `AMP_API_KEY` | yes | upgraded (install) |
| Goose | `agent/goose` | `goose` | `download_cli.sh` with `CONFIGURE=false` | TUI | provider keys | yes | upgraded (install) |
| Aider | `agent/aider` | `aider` | `aider-install` (pip) | TUI | provider keys | no | catalogued, now has a logo |
| Droid | `agent/droid` | `droid` | npm `droid` | TUI | `FACTORY_API_KEY` | yes | upgraded (install) |
| Qwen Code | `agent/qwen` | `qwen` | npm `@qwen-code/qwen-code` | TUI, ACP `--acp` | own `/auth` | yes | upgraded (ACP) |
| Crush | `agent/crush` | `crush` | npm `@charmland/crush` | TUI | provider keys | yes | upgraded (`--yolo`, logo) |
| Cline | `agent/cline` | `cline` | npm `cline` | TUI | `CLINE_API_KEY`, provider keys | yes | upgraded (`--yolo`, home `.cline`, key) |
| OpenHands | `agent/openhands` | `openhands` | `uv tool install openhands` | TUI | provider keys | yes | upgraded (install, `--always-approve`, home) |
| Grok Build | `agent/grok` | `grok` | `curl https://x.ai/cli/install.sh` | TUI, ACP `agent stdio` | `XAI_API_KEY` | no | catalogued |
| Kimi Code | `agent/kimi` | `kimi` | `curl https://code.kimi.com/kimi-code/install.sh` | TUI, ACP `acp` | `KIMI_API_KEY` | yes | catalogued |
| Pi | `agent/pi` | `pi` | npm `@earendil-works/pi-coding-agent` | TUI | provider keys | yes | catalogued |
| Auggie | `agent/auggie` | `auggie` | npm `@augmentcode/auggie` | TUI | Augment account (`~/.augment/session.json`) | yes | catalogued |
| Continue | `agent/continueagent` | `cn` | npm `@continuedev/cli` | TUI | not sourced | no | catalogued |
| Devin | `agent/devin` | `devin` | `curl https://cli.devin.ai/install.sh` | TUI | `DEVIN_API_KEY` | yes | catalogued |
| Kiro | `agent/kiro` | `kiro-cli` | `curl https://cli.kiro.dev/install` | TUI (`chat`) | `KIRO_API_KEY` | yes | catalogued |
| Kilo Code | `agent/kilocode` | `kilo` | npm `@kilocode/cli` | TUI | `KILO_API_KEY`, provider keys | yes | catalogued |
| Mistral Vibe | `agent/vibe` | `vibe` | `uv tool install mistral-vibe` | TUI | `MISTRAL_API_KEY` | yes | catalogued |
| Muse Code | `agent/muse` | `muse` | `curl https://dev.meta.ai/install.sh` | TUI | `META_API_KEY` | yes | catalogued |
| Antigravity | `agent/agy` | `agy` | `curl https://antigravity.google/cli/install.sh` | TUI, ACP `acp` | Google account (not sourced) | yes | catalogued |
| Autohand | `agent/autohand` | `autohand` | npm `autohand-cli` | TUI | `AUTOHAND_API_KEY`, provider keys | yes | catalogued |
| Kimchi | `agent/kimchi` | `kimchi` | GitHub release `install.sh` | TUI, ACP `--mode acp` | `KIMCHI_API_KEY` | yes | catalogued |
| Prime Agent | `agent/primeagent` | `prime-agent` | `curl https://app.primeintellect.ai/prime-agent/install.sh` | TUI | `PRIME_API_KEY`, provider keys | yes | catalogued |
| Oh My Pi | `agent/omp` | `omp` | `curl https://omp.sh/install` | TUI, ACP `acp` | not sourced | yes | catalogued |
| fx | `agent/fx` | `fx` | `curl https://fx.sh/setup.sh` | TUI | not sourced | no | catalogued |
| Codewhale | `agent/codewhale` | `codewhale` | none (AO installs it manually too) | TUI | not sourced | yes | catalogued, no install |
| MiMo Code | `agent/mimocode` | `mimo` | npm `@mimo-ai/cli` | TUI | per provider (not sourced) | yes | catalogued |
| MiniMax Code | `agent/minimaxcode` | `mcode` | npm `@minimax-ai/code` | TUI | `MINIMAX_API_KEY`, provider keys | yes | catalogued |
| DeepSeek Harness | `agent/deepseekharness` | `dsh` | npm `@deepseek-ai/dsh` | TUI | `DEEPSEEK_API_KEY` | no | catalogued |
| Command Code | `agent/commandcode` | `command-code` | npm `command-code` | TUI, ACP `acp` | not sourced | yes | catalogued |
| memcode | `agent/memcode` | `memcode` | `curl https://memcode.ai/install.sh` | TUI | `MEMCODE_API_TOKEN`, provider keys | yes | catalogued |
| Hermes Agent | `agent/hermes` | `hermes` | `curl https://hermes-agent.nousresearch.com/install.sh` | TUI, ACP `acp` | `NOUS_API_KEY`, `OPENROUTER_API_KEY`, provider keys | no | catalogued |
| Stakpak | `agent/stakpak` | `stakpak` | `curl https://stakpak.dev/install.sh` | TUI | `STAKPAK_API_KEY`, provider keys | no | catalogued |
| Docker Agent | `agent/dockeragent` | `docker-agent` | manual | ACP only | provider keys | no | not catalogued |
| OpenCode 2 | `agent/opencodev2` | not named | npm `@opencode/cli` | TUI, ACP `acp` | provider keys | yes | not catalogued |
| Unreal Agent | `agent/unrealagent` | built into AO | none | AO runtime | provider keys | no | not catalogued |
| OpenClaw | none | `openclaw` | none | TUI | not sourced | no | Polaris only |

AO helper packages that are not agents and were left out: `activitydispatch`,
`activitystate`, `agentbase`, `authprobe`, `binaryutil`, `cursorstore`, `fake`,
`hooksjson`, `hookutil`, `importcopy`, `modelcatalog`, `nativeconfig`,
`registry`, `terminalui`.

## Sign-in commands

Polaris runs a tool's own login in a throwaway container on the person's home
(`LOGIN_COMMANDS` in `apps/web/src/lib/agents/signin-runtime.ts`) and keeps the
credential it produces, encrypted, for the next container. A login is listed
only when its vendor's documentation names the command, the flow can finish
from a browser on another machine, and the credential it leaves is either
printed or kept in a known file. A logout is listed only when the vendor
documents one; it is never inferred from the login.

| Tool | Login | Logout | Source |
| --- | --- | --- | --- |
| Claude Code | `claude setup-token` | - (the token is not a home login) | existing entry |
| Codex | `codex login --device-auth` (file store) | `codex logout` (file store) | learn.chatgpt.com/docs/auth |
| Gemini CLI | `gemini` with Google sign-in selected | - | existing entry |
| GitHub Copilot | `copilot login --device-code` | - | existing entry |
| Auggie | `auggie auth login --headless` | `auggie auth logout` | docs.augmentcode.com/cli/setup-auggie/authentication |
| Devin (stored account) | `devin auth login --force-manual-token-flow` | `devin auth logout` | docs.devin.ai/cli/reference/commands, file from docs.devin.ai/cli/enterprise/devin-auth |
| Kimi Code (stored account) | `kimi`, then `/login`, with `KIMI_CODE_HOME` on the account's folder | - (removing the row clears the folder) | moonshotai.github.io/kimi-code/en/configuration/env-vars.html |
| Pi (stored account) | `pi`, then `/login`, with `PI_CODING_AGENT_DIR` on the account's folder | - (removing the row clears the folder) | npm `@earendil-works/pi-coding-agent` README |
| Autohand (stored account) | `autohand login` with `AUTOHAND_HOME` on the account's folder | - (removing the row clears the folder) | docs.autohand.ai/working-with-autohand-code/cli-reference |

Kept in the home (`home: true`): the login lands in the person's persistent
home, which every session mounts, and nothing is stored. Used where the vendor
documents the command but not where the login is kept. Listed under "Signed in
on your sessions' machine" under Polar > AI providers, each with a Sign out button
when the vendor documents one. A removed stored sign-in whose tool has a logout
is offered the same sign-out.

| Tool | Login | Logout | Source |
| --- | --- | --- | --- |
| Cursor | `NO_OPEN_BROWSER=1 cursor-agent login` | `cursor-agent logout` | cursor.com/docs/cli/reference/authentication (docs say `agent`; `cursor-agent` is the catalogue binary) |
| Kiro | `kiro-cli login` (device flow in remote environments) | - (none documented) | kiro.dev/docs/getting-started/authentication |
| Grok Build | `grok login --device-auth` | `grok logout` | docs.x.ai/build/cli/reference |
| Devin | `devin auth login --force-manual-token-flow` | `devin auth logout` | docs.devin.ai/cli/reference/commands (file: `~/.local/share/devin/credentials.toml`, docs.devin.ai/cli/enterprise/devin-auth) |
| Amp | `amp login` | `amp logout` | ampcode.com/docs/cli |
| Autohand | `autohand login` | `autohand logout` | docs.autohand.ai/working-with-autohand-code/cli-reference |
| fx | `fx login` (Vercel) | `fx logout` | fx.sh/docs/getting-started/authentication |
| MiMo Code | `mimo auth login` | - (none documented) | mimo.mi.com/docs/en-US/tokenplan/integration/mimo-code |
| MiniMax Code | `mcode login --region global` | `mcode logout` | code.minimax.io/docs/cli/quick-start |

Each home row shows whether it is signed in. Where the vendor documents a
status command (`status` in `LOGIN_COMMANDS`), Polaris runs it as the agent in
one short-lived container on the person's home, for all such tools at once, and
reuses the answer for a minute. No vendor documents the exit codes, so only a
clean exit that does not say "not logged in" (or similar) reads as signed in; a
tool not installed in the home reads as signed out; a check that fails reads as
unknown. Every other row shows the outcome of the last sign-in or sign-out run
from Polaris, labelled "last known". Both are kept in server memory only, so a
restart reads "unknown" until the next check or sign-in. The row offers one
action, Sign out when signed in (where a logout is documented) and Sign in
otherwise, with the other in its menu.

| Tool | Status | Source (checked 2026-11-16) |
| --- | --- | --- |
| Cursor | `cursor-agent status` | cursor.com/docs/cli/reference/authentication ("whether you're authenticated") |
| Kiro | `kiro-cli whoami` | kiro.dev/docs/getting-started/authentication ("which authentication method is active") |
| Devin | `devin auth status` | docs.devin.ai/cli/reference/commands ("Check authentication status") |

No status command is documented for Grok Build, Amp, Autohand, MiMo Code,
Kimi Code, Pi or Droid. fx documents `fx status` (active provider, model and
credential source) and MiniMax Code a TUI `/status`; neither says signed in or
not as a shell command, so both rows use the last known outcome.

Typed into the tool (`input`): the tool starts, and `/login` is typed once one
of its ready markers is on the screen (markers ported from Agent Orchestrator,
Apache-2.0). With no known marker, or one that never shows, the dialog offers a
"Type /login" button instead of typing on a guess.

| Tool | Typed | Ready marker | Source |
| --- | --- | --- | --- |
| Kimi Code | `/login` | `Run /login or /provider to get started.` | moonshotai.github.io/kimi-code/en/guides/getting-started |
| Pi | `/login` | `0.0%/`, `Pi can explain its own features` | github.com/earendil-works/pi README |
| Droid | `/login` | none known (button) | docs.factory.com/cli/configuration/cli-reference |

None of the above has been exercised: this machine has no Docker. The commands
are the vendors' documented ones; what each draws on screen was not seen.

## More than one account

How each home-login tool can hold a second account on the same machine, read
from the vendor's own documentation or package README on 2026-11-18. A tool
with a stored mechanism Polaris uses takes as many rows as somebody adds in
Add connection, each encrypted like every other credential, and a session
started on one is handed that one. The existing home login stays one row
beside them, so nothing an install already has is lost.

| Tool | More than one | Mechanism | Source |
| --- | --- | --- | --- |
| Cursor | yes | `CURSOR_API_KEY` (or `--api-key`); one stored key per account | cursor.com/docs/cli/reference/authentication |
| Kiro | yes, when the home is not signed in | `KIRO_API_KEY`; the browser login from `kiro-cli login` is checked first, so the key is only used while the home has none | kiro.dev/docs/getting-started/authentication |
| Grok Build | yes | `XAI_API_KEY`, filled from the xAI provider keys | docs.x.ai/build/overview |
| Devin | yes | `devin auth login` writes `$XDG_DATA_HOME/devin/credentials.toml`, else `~/.local/share/devin/credentials.toml`; stored per account as `DEVIN_ACCOUNT_AUTH`, as Auggie's file is | docs.devin.ai/cli/enterprise/devin-auth |
| Amp | yes | `AMP_API_KEY`, an access token from Settings (`sgamp_`); the docs say the CLI rejects the session token `amp login` stores | ampcode.com/docs/cli/execute-mode |
| Droid | yes | `FACTORY_API_KEY` | docs.factory.com/cli/configuration/cli-reference |
| fx | yes | `AI_GATEWAY_API_KEY` ("for a script or CI job"), filled from the Vercel AI Gateway provider keys | fx.sh/docs/getting-started/authentication |
| Kimi Code | yes | `KIMI_CODE_HOME` moves the data root, OAuth credentials included; each stored account (`KIMI_ACCOUNT_HOME`) signs in inside a folder of its own and a session on it gets `KIMI_CODE_HOME` on that folder. `KIMI_API_KEY` is only read from `config.toml`, never from the shell, so the catalogue's key does not sign it in | moonshotai.github.io/kimi-code/en/configuration/env-vars.html |
| Pi | yes | `PI_CODING_AGENT_DIR` overrides `~/.pi/agent`; each stored account (`PI_ACCOUNT_HOME`) signs in inside a folder of its own and a session on it gets `PI_CODING_AGENT_DIR` on that folder. Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) already take several rows | npm `@earendil-works/pi-coding-agent` README |
| Autohand | yes | `AUTOHAND_HOME` moves `~/.autohand`; each stored account (`AUTOHAND_ACCOUNT_HOME`) signs in inside a folder of its own and a session on it gets `AUTOHAND_HOME` on that folder. Where `autohand login` keeps the credential inside it is not documented (`--bare` mentions keychain reads) | docs.autohand.ai/working-with-autohand-code/cli-reference |
| MiMo Code | no | nothing documented: no variable, credential path or key; "No manual API Key configuration is required" | mimo.mi.com/docs/en-US/tokenplan/integration/mimo-code |
| MiniMax Code | no | no config-dir variable or credential path; `MCODE_PROVIDER_API_KEY` is read once by `mcode provider set-minimax-key`, not at each start | code.minimax.io/docs/cli/features.md |

Kimi Code, Pi and Autohand document a variable that moves the tool's whole
data folder but name no credential file inside it, so Polaris keeps a folder
per account instead of a file (`dir` on the catalogue credential,
`apps/web/src/lib/agents/account-folders.ts`). The folder is
`~/.polaris-accounts/<tool>/<id>` in the person's agent home, the one
directory both the sign-in container and every session container of that
person mount and that the box keeps between them; `<id>` is the sign-in
attempt's row id, checked against `[A-Za-z0-9_-]{1,64}` before it is part of a
path. The sign-in runs with the tool's variable on that folder, so whatever the
vendor's login writes lands there; the stored row holds only the id; a session
started on the account gets the variable on the folder (only in a container on
the person's own home: a shared workspace or a server gets the machine's own
login), with Polaris's hooks written into it. Removing the row clears the
folder. The existing home login of each stays its own row. MiMo Code and
MiniMax Code still say on their Add connection card that one account is held at
a time (`single` in `LOGIN_COMMANDS`).

`KIMI_API_KEY`, `AUTOHAND_API_KEY` and `MINIMAX_API_KEY` stay in the catalogue
as Agent Orchestrator has them; none of the three is named by its vendor's
documentation as a variable the CLI reads.

Not listed, and why (checked 2026-11-15):

- **Continue**: `cn login` is documented as a browser flow; nothing says it can
  finish from another machine, and no credential location or logout is named.
- **OpenCode, Kilo Code**: their docs name only `/connect` inside the tool
  (opencode.ai/docs/providers, kilo.ai/docs/code-with-ai/platforms/cli), not the
  `auth login`/`logout` subcommands AO runs, and no ready marker is known.
- **Crush**: no login subcommand documented (README: ctrl+l and paste a key).
- **Cline**: `cline auth` only stores a provider API key
  (docs.cline.bot/cline-cli/cli-reference); the key field already does that.
- **Stakpak**: `stakpak auth login --api-key` only stores a key (README).
- **Command Code**: `cmd login` stores an API key in `~/.commandcode/auth.json`
  (commandcode.ai/docs/quickstart); its docs send containers to
  `COMMAND_CODE_API_KEY`, which the key field already takes.
- **Kimchi**: `kimchi login` hands the key back to the CLI from a local browser
  (docs.kimchi.dev/docs/service-keys), which cannot finish from another machine.
- **Qwen**: OAuth is `/auth` inside the tool, and its docs say containers should
  use an API key instead (qwenlm.github.io/qwen-code-docs/en/users/configuration/auth).
- **Muse, Prime Agent**: no vendor page documenting a login was found (AO links
  ai.meta.com/llama and a quickstart that returns 404).
- **Codewhale**: `codewhale login` (one-time code) and `codewhale account
  logout` are documented (codewhale.net/en/docs/auth), but the catalogue has no
  sourced install line, so a sign-in machine would have nothing to run.
- **MiniMax Code (Mainland China)**: only the Global region is offered; the bare
  `mcode login` is the China one.
- **Setup wizards** (Goose, Vibe, Hermes, OpenHands, DeepSeek Harness, OMP):
  AO drives a first-run wizard rather than a login; not ported.

## Left out, and why

- **Docker Agent**: AO runs it only as an ACP chat started with a configuration
  file it writes (`serve acp <config>`). It has no terminal mode for a session to
  start.
- **OpenCode 2**: AO never names its binary, and the obvious one (`opencode`) is
  already OpenCode's. Adding it waits on a verified binary name.
- **Unreal Agent**: built into AO, with nothing to install on its own.
- **Model flags and model catalogs**: most new agents take `--model`, but the
  catalogue's `model` field also needs the models.dev provider each one runs.
  That was not verified, so none of them takes a model from Polaris yet.
- **Hooks for the new agents**: AO writes hooks for most of them (see the AO
  hooks column), each in its own format. None was added: a hook file in the wrong
  shape is silently ignored, and each format has to be checked against the tool.
- **Headless flags** (`auggie --print`, `qwen -p`, ...): not checked against each
  tool's documentation, so these tools keep their terminal.
- **OpenHands credentials**: AO hands it `LLM_API_KEY` only together with
  `--override-with-envs`, which Polaris cannot add conditionally. The existing
  provider keys were left as they were.
- **Gemini CLI and Claude Code ACP**: AO starts them through separate adapters
  (`claude-code-acp`, Gemini's own driver) whose arguments are not plain flags on
  the binary.

## Logos

Agents with an inline mark keep it (`apps/web/src/components/model-marks.tsx`).
The rest are drawn from files under `dashboard/apps/web/public/logos/agents/`,
copied from AO's `frontend/src/renderer/assets/agents/` (Apache-2.0). A
`-dark`/`-light` pair is shown by theme. The marks are their owners' trademarks;
Polaris uses them only to name the tool.

| Files | Source | License |
| --- | --- | --- |
| aider, crush, kiro, vibe, muse, agy, kimchi, omp, mimo-code, minimax-code, memcode, hermes | AO assets | Apache-2.0 (AO) |
| grok, kimi, pi, auggie, continue, devin, kilocode, autohand, prime-agent, fx, deepseek-harness, command-code (dark/light) | AO assets | Apache-2.0 (AO) |
| codewhale (dark/light) | AO, from Hmbown/Codewhale v0.10.0 | MIT, `LICENSE-codewhale.txt` |
| mimo-code | AO, from XiaomiMiMo/MiMo-Code | MIT, `LICENSE-mimo-code.txt` |
| stakpak | AO, from stakpak/agent v0.3.88 | Apache-2.0, `LICENSE-stakpak.txt` |

The vendors' own brand kits could not be fetched from the development machine,
so AO's copies were used. Replace any of them with the vendor's official file
when one can be sourced.
