# U6 - what is left

Done on `feat/ao-signin-commands`: `LoginCommand.logout`, `signinCommand()`,
`canSignout()`, `beginSignin(..., "logout")` (no direct rung, never captured),
`beginAgentSignoutAction` in `account/ai-keys/actions.ts`, Auggie's headless
login with its session file captured, Codex's documented logout, the
documented/not-documented ledger in `docs/agent-catalogue.md`
("Sign-in commands"), tests in `test/agents/signin-commands.test.ts`.

Remaining, in order:

1. **Sign-out button.** `components/model-keys/signin-dialog.tsx` and
   `model-keys-view.tsx`: when a stored sign-in row is removed and
   `canSignout(env)` holds, offer "Also sign out of <tool> on your sessions"
   that opens the same dialog with `beginAgentSignoutAction` as `begin` and no
   capture step (pass `canSignout` per signin through `assistedSignins()` /
   `AgentSignin`). i18n en-US + es-ES under `account.aiKeys`, Spanish within the
   length rule. Ends the attempt on exit like a login.
2. **Home-only sign-ins.** For tools whose login is documented but whose
   credential location is not (Cursor `NO_OPEN_BROWSER=1 cursor-agent login`,
   Kiro `kiro-cli login` device flow), the login already lands in the
   person's persistent home (`agentHomeSource(userId)` bind mount), so it works
   without a captured file. It needs a sign-in kind with no stored row: a
   catalogue flag (not a credential `env`), a dialog end state that stores
   nothing, and a status read from the vendor's documented status command
   (`cursor-agent status`, `kiro-cli whoami`). Core change -> extension bump.
3. **Vendor-doc checks still open** for AO's login subcommands of MiMo Code,
   Crush, Cline, Muse, Autohand, fx, Command Code, Stakpak, Codewhale, and a
   second look for Amp, Devin, Grok, OpenCode, Kilo Code (their auth pages
   were not found in this pass). Add each verified one as one
   `LOGIN_COMMANDS` row plus a file credential when the location is sourced.
4. **TUI logins** (AO `terminalInputPlan` / `initialInput`): send `/login`
   once a ready marker is on the screen (`signinScreen` already reads the
   screen and has `autoAnswers`; a ready-marker answer with no prompt is the
   smallest extension). Not exercised: no Docker on the dev machine.
