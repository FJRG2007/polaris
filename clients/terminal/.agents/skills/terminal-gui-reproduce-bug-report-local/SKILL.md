---
name: terminal-gui-reproduce-bug-report-local
specializes: reproduce-bug-report
specializes_source: warpdotdev/common-skills:.agents/skills/reproduce-bug-report
description: GUI desktop app only. Repo-specific bug reproduction guidance for Polaris Terminal. Specializes the core reproduce-bug-report skill for logged-out Polaris Terminal UI repros, exact reporter-version installs, and login-free onboarding.
---

# Repo-specific bug reproduction guidance for `polaris-terminal`

**Scope — GUI desktop app only.** This skill applies to Polaris Terminal's **GUI** desktop front-end (the `app/` crate on the PtermUI pixel/GPU framework). It does **not** apply to the headless **TUI** front-end (`crates/pterm_tui`; cell-grid `TuiElement` library under `crates/ptermui_core/src/elements/tui`), which has its own components, tests, and change-verification workflow. For TUI work, see the `terminal-tui-ui-guidelines`, `terminal-tui-testing`, and `terminal-tui-verify-change` skills instead.

## Prerequisite: install the parent skill

This skill specializes the core `reproduce-bug-report` skill (named in the `specializes` frontmatter field) and is not functional on its own. Before applying its guidance, confirm the parent skill is installed and resolvable at `.agents/skills/reproduce-bug-report/SKILL.md`. If it is missing, install it first by copying the skill directory from the source declared in the `specializes_source` frontmatter field (`warpdotdev/common-skills:.agents/skills/reproduce-bug-report`). Then continue with the guidance below.

This file is a companion to the core `reproduce-bug-report` skill. It does not redefine the shared Oz computer-use orchestration, artifact handling, safety rules, or reporting format. It specializes scope and setup for Polaris Terminal bug reports.

## Scope

- Use this workflow only for Polaris Terminal bugs that can be exercised while the app remains logged out.
- Apply it to UI-visible Polaris Terminal bugs, interaction bugs, rendering/layout bugs, logged-out onboarding bugs, settings bugs, editor/display bugs, terminal-display bugs, and other visual or interactive issues where screenshots or recordings would help.
- Do not use it for authenticated-user flows, account-specific state, cloud-synced state, logged-in onboarding, or AI behaviors that require login.
- If a report requires authentication, account state, cloud sync, or another logged-in-only capability, do not launch a repro agent with this local specialization; report that it is out of scope for the current logged-out Polaris Terminal workflow.

## Polaris Terminal version and install strategy

- Prefer reproducing against the exact Polaris Terminal version/build and channel reported by the user.
- Do not build Polaris Terminal from source by default. Install the matching Linux package or binary release for the reporter's version/channel instead.
- If the bug report names a macOS or Windows build, use the corresponding Linux build from the same version/channel when a matching Linux artifact exists, and state that this is a Linux proxy for the reporter's platform.
- Use the repository's or Polaris Terminal release tooling/docs available in the environment to find and install the exact versioned Linux artifact. Do not silently substitute the latest stable build when an exact matching version can be installed.
- If the exact version/build cannot be found or installed, report that clearly, explain what was attempted, and use the closest justified fallback only when it is useful for continuing the investigation.
- Record the requested reporter Polaris Terminal version, the installed Linux version, the source of the installed artifact, and any fallback decision in the manifest and final report.

## Logged-out Polaris Terminal baseline

- Keep Polaris Terminal logged out for the entire repro attempt. Do not create an account, sign in, paste auth tokens, or use real user credentials.
- Launch Polaris Terminal and complete the login-free / continue-without-account onboarding path until a normal logged-out terminal session is usable.
- Capture a post-onboarding baseline screenshot before attempting the bug-specific reproduction.
- If the assigned bug cannot be exercised after entering a normal logged-out Polaris Terminal session, stop and report the blocker instead of improvising an authenticated flow.

## Local prompt additions

When applying the core skill to Polaris Terminal, ensure the parent prompt and child prompts include:

- Reporter Polaris Terminal version/build/channel: the exact value from the report, or `unknown`.
- Build/app target: the exact versioned Linux Polaris Terminal package/binary to install, or the justified fallback if an exact artifact is unavailable.
- Assigned Polaris Terminal state: first-run logged-out state, completed logged-out onboarding, terminal/session/layout/settings state, or the targeted code-path hypothesis.
- A reminder that Polaris Terminal must remain logged out and that logged-in-only reports are blocked for this specialization.

## Local reproduction priorities

- Match the reporter's Polaris Terminal version/build/channel before broadening the search space.
- Follow the issue's exact steps first, then test at most two targeted variations supported by the issue or by a code-path hypothesis.
- Prefer targeted hypotheses derived from Polaris Terminal UI strings, settings names, feature names, telemetry names, route names, and relevant components over broad exploratory clicking.
- In the final report, include:
  - the reporter-requested Polaris Terminal version/build/channel
  - the installed Linux Polaris Terminal version/build/channel
  - the package or binary source
  - whether a fallback was used
  - whether the test was a Linux proxy for a macOS or Windows report
