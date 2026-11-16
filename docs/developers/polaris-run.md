# Running agents from scripts and CI

`plr run` starts a coding agent session on your Polaris, sends it a prompt and
follows it until the turn ends. The agent's answer goes to stdout and what it
does along the way to stderr, so `plr run "..." > answer.md` keeps only the
answer.

```sh
export POLARIS_URL=https://polaris.example.com
export POLARIS_TOKEN=plk_...   # an API key with agents.manage
plr run "Fix the failing test in src/cart" --repo acme/shop
```

| Option | What it does |
| --- | --- |
| `--repo OWNER/NAME` | The repository the session works in. Without it, a workspace with nothing checked out. |
| `--agent ID` | Which coding agent runs it (`claude` unless you say otherwise). |
| `--model PROVIDER/MODEL` | One of the models you can start that agent on in Polar Code. Without it, the agent's own default. |
| `--title TEXT` | The session's title. The prompt's first line otherwise. |
| `--continue ID` | Send the prompt to that session instead of starting one. |
| `--format json` | Print every frame of the session's event stream as a line of JSON. |
| `--stop` | End the session when the run is over. |

Exit codes: `0` when the turn ends, `1` when it fails or the session ends
without finishing it, `3` when the agent stops to ask something. Answer it
with `plr run --continue <id> "<answer>"`.

The key comes from Account > API keys and needs the `agents.manage`
permission. The key `plr login` stores is limited to deploying, so set
`POLARIS_TOKEN` for `plr run`.

## In GitHub Actions

The `polaris-run` action downloads the CLI from your own Polaris and runs it.
Keep the key in a repository secret.

```yaml
name: Ask Polaris
on:
  workflow_dispatch:
    inputs:
      prompt:
        description: What the agent should do
        required: true
  issue_comment:
    types: [created]

permissions:
  contents: read

jobs:
  run:
    # Only a comment that asks for it, from somebody with write access.
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (startsWith(github.event.comment.body, '/polaris ') &&
       contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association))
    runs-on: ubuntu-latest
    steps:
      - uses: FJRG2007/polaris/.github/actions/polaris-run@main
        with:
          url: ${{ vars.POLARIS_URL }}
          token: ${{ secrets.POLARIS_TOKEN }}
          repo: ${{ github.repository }}
          prompt: ${{ github.event.inputs.prompt || github.event.comment.body }}
```

The workflow never checks out code: the agent works on its own clone inside
Polaris, so nothing from a pull request runs on the runner with your secret.
Do not adapt this to `pull_request_target` with a checkout of the pull
request's code.

## From your own code

`@polaris/sdk` is the typed client the CLI is built on:

```ts
import { createPolarisClient } from "@polaris/sdk";

const polaris = createPolarisClient({ baseUrl: process.env.POLARIS_URL!, token: process.env.POLARIS_TOKEN! });
const { session } = await polaris.sessions.create({ prompt: "Update the changelog", repo: "acme/shop" });
for await (const frame of polaris.sessions.events(session.id)) {
    if (frame.type === "message" && frame.data.role === "agent") console.log(frame.data.body);
    if (frame.type === "event" && frame.data.kind === "turn.end") break;
}
```

`events()` reconnects by itself and picks up after the last frame it received,
so a dropped connection neither repeats nor skips anything. The routes are in
the API reference under Polar: `/api/v1/sessions` and the routes below it.
