# Settings

[Leer en español](settings.es.md) - [Back to the README](../../README.md)

Two kinds of settings: the deployment's, for whoever runs Polaris, and each
person's own account.

Every picture is the real interface drawn with made-up people and data, and
follows your light or dark setting. Phone-sized versions are in
[docs/assets/media](../assets/media).

## The deployment

<picture>
  <source media="(prefers-color-scheme: light)" srcset="../assets/media/settings-light-en-desktop.webp">
  <img src="../assets/media/settings-dark-en-desktop.webp" alt="The deployment's settings with an update ready to install">
</picture>

Updates install from the Update button, on a schedule you pick, or as soon as
one is published - from the published build, or built on this host. The page
shows where Polaris is reachable, its public pages for OAuth providers, the
seasonal themes, and a way to move everything to another machine in one
passphrase-sealed file.

## People and access

<picture>
  <source media="(prefers-color-scheme: light)" srcset="../assets/media/settings-users-light-en-desktop.webp">
  <img src="../assets/media/settings-users-dark-en-desktop.webp" alt="Every account with its roles, limits and two-step sign-in, and the invitations waiting">
</picture>

Every account in one list: its roles, whether it is an administrator, limited to
some countries or networks, suspended, or signed in with a second step, and when
and from where it was last seen. Invitations still waiting sit above it, and
each row opens the account's own record.

## Roles and permissions

<picture>
  <source media="(prefers-color-scheme: light)" srcset="../assets/media/settings-roles-light-en-desktop.webp">
  <img src="../assets/media/settings-roles-dark-en-desktop.webp" alt="The member role's permissions, ticked app by app">
</picture>

Everyone holds a role, and a role is a list of permissions, app by app: who
may delete files, run a mail server, op players on a game server or change
instance settings. The built-in roles (admin, member, viewer, guest) can be
rewritten, new ones added, and "View as" shows Polaris as somebody with that
role sees it. An app a role cannot use is not shown to them at all.

## Your account

<picture>
  <source media="(prefers-color-scheme: light)" srcset="../assets/media/account-security-light-en-desktop.webp">
  <img src="../assets/media/account-security-dark-en-desktop.webp" alt="Account security: password, two-factor methods, PIN and session limits">
</picture>

How you prove it is you, and how long a session stays open: password,
authenticator app, codes by email or WhatsApp, passkeys, backup codes, a quick
unlock PIN, trusted devices, sign-in with a connected account, idle lock and
session limits, and a successor for your organizations. The account also has
its profile, privacy, notifications, sessions, API keys and the AI assistants
that may act as you.

## Everything else is configurable too

Chat has [rules for the whole instance](chat.md#rules-for-the-whole-instance),
[settings per channel](chat.md#channel-settings) and
[your own privacy](chat.md#your-privacy); Mail has
[its own settings](mail.md#settings).
