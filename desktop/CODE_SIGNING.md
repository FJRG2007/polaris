# Code signing policy

The Windows installer and executable of the Polaris desktop app are signed.

Free code signing provided by [SignPath.io](https://signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

## What is signed

Only what is built from this repository by its release workflow,
[`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml), on GitHub
Actions from a `desktop-v*` tag: the app's `polaris.exe` and the
`Polaris-Setup.exe` installer. Nothing built on a personal computer is
signed. Upstream components shipped inside the installer, such as the Electron
runtime libraries and Squirrel's updater, are left as their projects publish
them.

## Team roles

- **Committers and reviewers:** the members of the
  [FJRG2007/polaris](https://github.com/FJRG2007/polaris) repository with write
  access. A change from anybody else is reviewed by one of them before it is
  merged.
- **Approvers:** the repository's owner,
  [FJRG2007](https://github.com/FJRG2007), approves each signing request in
  SignPath.

Every member must use multi-factor authentication on GitHub and on SignPath.

## Privacy policy

This program will not transfer any information to other networked systems
unless specifically requested by the user or the person installing or operating
it. It connects only to:

- the Polaris server the user signs in to, which is theirs or their
  organization's;
- the sign-in pages of an outside account, when the user connects one or
  signs in with it;
- GitHub, without credentials, to check for a newer release of this app and to
  download it.
