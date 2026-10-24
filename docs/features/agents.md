# Agents

[Leer en español](agents.es.md) - [Back to the README](../../README.md)

Coding agents in your repositories. A run reviews pull requests, answers issues,
fixes failing checks and opens pull requests when you ask it to. A session puts
an agent in a branch of its own, on a machine you already have, where you watch
it work, answer its questions and send it the next thing.

Agents lives under **Apps > Agents**, with Repositories, Runs, Sessions,
Automations and Settings.

## Before the first run

**Setup** lists the three things that have to be true:

1. **A GitHub App.** It lets the agent comment, review and open pull requests
   as itself, and lets Polaris hear about issues and pull requests. A personal
   access token cannot do either. An administrator creates it in one click
   under **Management > Integrations & AI > Integrations** (see
   [Setting up integrations](../integrations-setup.md#github)).
2. **A model provider.** Your own key with Anthropic, OpenAI, Google, xAI,
   DeepSeek, Moonshot, Groq, Cerebras or OpenRouter, or an OpenAI-compatible
   gateway, added under **AI provider keys**. The key stays in Polaris and is
   never copied into your repositories.
3. **A repository**, and where its runs happen.

Then open an issue in one of your repositories and mention the app to try it.

## Repositories and where runs happen

Add a repository and pick where its runs happen. Polaris recommends the
cheapest option that fits; the choice is yours.

| Option | What it means |
| --- | --- |
| GitHub Actions | A GitHub-hosted machine. Free on public repositories, billed per minute on private ones |
| Polaris runners | One of your enrolled servers through a runner pool (Apps > Runners). A private repository still spends Actions minutes |
| Polaris server | A container on the Polaris machine, without GitHub Actions. Nothing is metered and no workflow file is needed |

Each repository also sets what the agent may do:

- **Push**: read-only, feature branches only (the default for a new
  repository: no pushes to the default branch, no branch deletes, no tags), or
  full access.
- **Shell**: no shell, a shell with secrets filtered out of its environment, or
  a full shell.
- **Gate**: push as soon as it is done, run quick checks before the push, or add
  review, test and documentation passes.

## Runs and automations

A repository with no rules answers only when somebody mentions the app in an
issue, a pull request or a comment. **Automations** add rules that start a run
on their own: an issue opened or labeled, a pull request opened, a review
requested or submitted, or a failed check. A rule can be limited to labels and
branches, and carries your own instructions for the agent.

**Start a run** from Polaris with a prompt you write. **Runs** lists every run,
what started it, where it ran and how it ended, with a link to the job and a
button to stop it. A task can be handed to an agent from its panel.

## Sessions

**Start a session** and choose:

- what it is working on, and a repository - or none, for an empty workspace of
  your own;
- the agent: Claude Code, Codex, OpenCode, Gemini CLI, GitHub Copilot CLI,
  Cursor CLI, Amp, Goose, Aider, Droid, Qwen Code, Crush, Cline, OpenHands,
  OpenClaw, or a custom one already installed on the machine;
- where it runs: this Polaris machine or one of your enrolled servers;
- the branch to start from, and an optional first prompt;
- **Let it work without asking**, so it does not wait on its own permission
  prompts.

The session page shows the conversation and the agent's activity. **See its
screen** shows its terminal, **Take the terminal** lets you type into it, and
**Interrupt** stops what it is doing. **Changes** shows the diff against where
the branch started. **Open a pull request** pushes the branch and opens one,
committing anything not yet committed. If a push fails the work is kept, to try
again or discard. When a session ends its branch is still there. Sessions can be
shared with other people.

An agent signs in with an account under **AI provider keys > Your agent
accounts**: a subscription costs nothing extra, an API key is metered. A machine
keeps its home between sessions, so installs and sign-ins happen once.

## Settings

**Settings** holds what your repositories inherit: set it once, narrow it per
account, and override it on the repositories that need something different.
This includes whether public and private repositories are allowed and which
models a run falls back to, in order, when a provider turns it away.

An assistant you connect can list sessions, start them and send them prompts
when you approve those permissions. See
[Connecting AI assistants](../connecting-ai-assistants.md).
