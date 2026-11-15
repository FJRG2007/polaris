# U13 - what is left

Everything in the unit is built and tested on `feat/ao-codex-accounts`: per-account Codex
homes, the explicit switch, Codex usage-limit detection from the rollout
(`lib/agents/codex-turn-failures.ts`, history read + one-minute sweep), and the mid-turn
restart on the new account (`moveAgentToAccount` / `promptMovedAgent` in `session-runtime.ts`,
`relaunchAgentCommand` in `session-commands.ts`).

Remaining, and only because Docker is not available on the development machine:

1. **Run it in a real session container.** The scripts are tested on a real shell (Git Bash),
   tmux and Codex are not. Check on a live Codex session with two ChatGPT accounts:
   - the hook payload's `transcript_path` is under `.polaris-accounts/codex/<id>/sessions/`
     and the history still reads it;
   - a usage limit ends the turn ("Working" clears) and the session moves to the next
     account within a minute, with the turn typed again once Codex resumed;
   - a switch mid-turn: Esc stops the turn, `tmux respawn-pane -k` brings Codex back on
     `codex resume <id>` with the new `CODEX_HOME`, and the conversation is intact.
