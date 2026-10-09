# Contributing to Polaris

## Before Submitting an Issue

Check that [our issue database](https://github.com/FJRG2007/polaris/issues)
doesn't already include that problem or suggestion before submitting an issue.
If you find a match, you can use the "subscribe" button to get notified on
updates. Do *not* leave random "+1" or "I have this too" comments, as they
only clutter the discussion, and don't help resolving it. However, if you
have ways to reproduce the issue or have additional information that may help
resolving the issue, please leave a comment.

Security problems are not filed as issues: report them privately to the
maintainer listed in [CITATION.cff](CITATION.cff).

## Writing Good Bug Reports and Feature Requests

Please file a single issue per problem and feature request. Do not file combo
issues. Please do not submit multiple comments on a single issue - write your
issue with all the environmental information and reproduction steps so that an
engineer can reproduce it.

Polaris runs on very different hardware - a NAS, a mini PC, a rented server,
several enrolled machines at once - so most problems depend on the setup they
happen on. Help us in advance by including:

* The build you are running: **Admin > Updates & settings > Running build**.
* The edition: **full** (the Update button works) or **limited**.
* Where it runs: OS and version, and the hardware (NAS model, mini PC, VPS...).
* The browser and device you were using, if the problem is in the interface.
* Reproducible steps, what the result of the steps was, and what you would
  have expected.

The issue forms ask for each of these.

## Contribute

Contributions to Polaris are welcome. Here is how you can contribute:

1. [Submit bugs or a feature request](https://github.com/FJRG2007/polaris/issues) and
   help us verify fixes as they are checked in.
2. Create your working branch from the `main` branch: `git checkout main -b feat/my-awesome-feature`
   (`fix/...` for a bug fix).
3. Set up the part you are changing - the dashboard, the Rust crates and plugins, or the
   desktop app. The [developer guide](docs/developers/README.md) covers each one. For the
   dashboard:

   ```sh
   cd dashboard
   npm install
   npm run dev:up            # http://localhost:3000, no containers needed
   ```

4. Write code for a bug fix or for your new awesome feature. Read [CLAUDE.md](CLAUDE.md)
   first: it lists the rules that are specific to this project, such as "the person running
   Polaris never touches a terminal" and how an installed copy receives your change.
5. Write test cases for your changes, and run the checks before opening a pull request:

   ```sh
   npm run typecheck
   npm run lint
   npm run test
   npm run build
   ```

6. [Submit pull requests](https://github.com/FJRG2007/polaris/pulls) for bug
   fixes and features and discuss existing proposals. Commit subjects follow
   [Conventional Commits](https://www.conventionalcommits.org) with a leading emoji,
   as in the history: `✨ feat(chat): ...`, `🐛 fix(deploy): ...`.

## License of contributions

Polaris is licensed under the [GNU AGPL-3.0](LICENSE) with the additional terms
in [NOTICE.md](NOTICE.md), and is also offered under a separate commercial
license. By submitting a contribution, you agree that:

* it is licensed under the AGPL-3.0 and those additional terms, and
* you grant the Polaris maintainer a perpetual, worldwide, royalty-free right to
  also license it under other terms, including the commercial license.

You keep the copyright of what you contribute. Only submit work you have the
right to contribute.
