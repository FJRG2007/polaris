---
name: test-rook-ui
description: >
  Guides testing Rook UI features and changes using the computer use tool.
  Use this skill only when computer-use testing was requested (explicit request or accepted offer) and the computer_use tool is available to the agent.
  Covers launching Rook and verifying UI behavior.
user-invocable: false
---

# Computer Use for Rook UI Testing

Use the `computer_use` tool to visually test that Rook looks and behaves as intended after UI changes, when computer-use testing was requested.

## Running Rook

Launch Rook from the repository root. The exact command depends on which environment variable holds the API key:

- If `ROOK_API_KEY` is already set, omit the flag entirely — the `--api-key` flag is bound to `ROOK_API_KEY`, so Rook reads it automatically:

  ```bash
  cargo run --bin rook
  ```

- If the key is in `STAGING_USER_ROOK_API_KEY` instead, pass it explicitly via the flag:

  ```bash
  cargo run --bin rook -- --api-key $STAGING_USER_ROOK_API_KEY
  ```

Always pass `--bin rook` explicitly. That target builds the internal (dogfood) channel, which is the only channel that honors `--api-key` for the GUI app. A plain `cargo run` builds the OSS channel, which ignores the key and falls back to interactive onboarding.

Authenticating this way starts the app directly without interactive login prompts.

Initial builds may take several minutes; subsequent incremental builds are faster.

### Verify the launch is authenticated

After launching, confirm both of the following before testing:

- Rook is **authenticated** — it opens straight to the terminal, NOT the logged-out onboarding/sign-in screen.
- The `cargo run` stderr/terminal output does **not** contain the substring `provided but IGNORED`.

If that warning appears (or the app is logged out), the wrong binary/channel was launched — stop and relaunch with `cargo run --bin rook`.

## Testing Workflow

### 1. Hardcode or Mock Data (When Needed)

If you just need to verify that a specific UI looks correct, it can be useful to hardcode or mock data so the UI state is immediately reachable without navigating a full flow. This is optional — skip this step when testing end-to-end flows that should work naturally.

Examples of when to hardcode:

- **Conditional UI**: The feature only appears under certain conditions (e.g., a specific setting, a non-empty data set, an active subscription) — hardcode the condition so the UI always appears.
- **Feature flags**: The feature is behind a flag that isn't enabled yet — enable it directly.
- **Error states**: You want to test error handling UI — hardcode error responses or failure conditions.

Keep mocked changes minimal and focused — only change what's necessary to reach the UI state under test.

### 2. Invoke Computer Use

Call the `computer_use` tool with a task description that includes:

- The command to build and launch Rook from the repo root: `cargo run --bin rook` when `ROOK_API_KEY` is set in the environment, or `cargo run --bin rook -- --api-key $STAGING_USER_ROOK_API_KEY` when the key is in `STAGING_USER_ROOK_API_KEY` instead
- Step-by-step instructions for navigating to the UI being tested
- **Specific observations to report**: describe exactly what elements, text, colors, layout, or states the tool should observe and describe back
- Do **not** include expected values in the task — the tool should report what it sees, not judge correctness

### 3. Verify Results

Compare the observations returned by `computer_use` against your expectations. If the UI doesn't match, investigate and adjust the code or mocks accordingly.

## Tips

- **Be specific in task descriptions**: Instead of "check if the dialog looks right," say "open Settings, click the General tab, and describe the text and layout of the first section."
- **Test one thing at a time**: Focused tests are easier to debug when observations don't match expectations.
- **Build before invoking**: Always confirm the build succeeds before calling `computer_use`. The tool cannot fix build errors.
