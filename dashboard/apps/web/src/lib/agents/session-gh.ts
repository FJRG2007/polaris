/**
 * The GitHub CLI inside a session.
 *
 * The session image does not carry `gh`, and the agent holds no GitHub token of
 * its own (see `gitCredentialScript`), so an agent asked to read the issues of
 * the repository it works in had nothing to do it with. The boot puts one pinned
 * release in the kept home - checked against the release's own SHA256 before it
 * is unpacked, and only when the machine has no `gh` already - and a wrapper
 * beside the checkout that asks the same credential helper git uses for a token
 * on each run. The token lives in that one `gh` process's environment: never in
 * the boot environment, never in a file, never printed, and a tool that would
 * read `GH_TOKEN` to decide it is signed in (Copilot CLI) still sees none.
 *
 * Fixed text: nothing a person typed is interpolated into either script.
 */

/** The pinned release. A bump changes the version and both sums together, read
 *  from the release's `gh_<version>_checksums.txt`. */
export const GH_VERSION = "2.103.3";

/** SHA256 of each release archive, by `uname -m` family. */
export const GH_SHA256 = {
    amd64: "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d",
    arm64: "ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63"
} as const;

/** Where the release lands, in the home that is kept between sessions (on a
 *  server, inside Polaris's own directory, so it never shadows the person's). */
export const GH_DIR = `$HOME/.polaris/tools/gh-${GH_VERSION}`;

const RELEASE = `https://github.com/cli/cli/releases/download/v${GH_VERSION}`;

/**
 * Install the pinned release as the agent, unless it is already there. Exits
 * non-zero when it did not install; the boot treats that as "no gh", never as
 * a reason to stop.
 */
export const GH_INSTALL_SCRIPT = [
    `d="${GH_DIR}"`,
    '[ -x "$d/bin/gh" ] && exit 0',
    'case "$(uname -m)" in',
    `    x86_64|amd64) a=amd64; sum=${GH_SHA256.amd64} ;;`,
    `    aarch64|arm64) a=arm64; sum=${GH_SHA256.arm64} ;;`,
    '    *) echo "polaris: there is no GitHub CLI for this machine\'s processor"; exit 1 ;;',
    "esac",
    `echo "polaris: installing the GitHub CLI ${GH_VERSION}"`,
    't="$(mktemp -d)" || exit 1',
    `u="${RELEASE}/gh_${GH_VERSION}_linux_$a.tar.gz"`,
    `curl -fsSL --proto '=https' --proto-redir '=https' -o "$t/gh.tgz" "$u" 2>/dev/null || wget -q --https-only -O "$t/gh.tgz" "$u" || { rm -rf "$t"; exit 1; }`,
    'got="$( (sha256sum "$t/gh.tgz" 2>/dev/null || shasum -a 256 "$t/gh.tgz" 2>/dev/null) | cut -d" " -f1)"',
    '[ "$got" = "$sum" ] || { echo "polaris: the GitHub CLI download did not match its checksum"; rm -rf "$t"; exit 1; }',
    'tar -xzf "$t/gh.tgz" -C "$t" || { rm -rf "$t"; exit 1; }',
    'mkdir -p "$(dirname "$d")"',
    // Two sessions on one shared home can race here; the loser finds it done.
    `[ -e "$d" ] || mv "$t/gh_${GH_VERSION}_linux_$a" "$d"`,
    'rm -rf "$t"',
    '[ -x "$d/bin/gh" ]',
    ""
].join("\n");

/**
 * The `gh` the agent finds first on its PATH, in `<state>/bin`. It reads the
 * real binary's path from `<state>/gh-path` and a token from the session's
 * credential helper (`git-credential.sh token`), which Polaris mints for this
 * session's one repository. A failed mint falls back to whatever token the
 * agent's environment already had, so `gh` still says why it was refused.
 */
export const GH_WRAPPER_SCRIPT = [
    "#!/bin/sh",
    "# Written by Polaris. Runs the GitHub CLI with a short-lived token for this session's repository.",
    'd="$(cd "$(dirname "$0")/.." && pwd)"',
    'real="$(head -n 1 "$d/gh-path" 2>/dev/null)"',
    '[ -n "$real" ] && [ -x "$real" ] || { echo "polaris: the GitHub CLI is not installed in this session" >&2; exit 127; }',
    'if [ -f "$d/git-credential.sh" ]; then',
    '  token="$(sh "$d/git-credential.sh" token 2>/dev/null)"',
    '  if [ -n "$token" ]; then GH_TOKEN="$token"; export GH_TOKEN; fi',
    "  unset token",
    "fi",
    'exec "$real" "$@"',
    ""
].join("\n");

const INSTALL_BASE64 = Buffer.from(GH_INSTALL_SCRIPT, "utf8").toString("base64");
const WRAPPER_BASE64 = Buffer.from(GH_WRAPPER_SCRIPT, "utf8").toString("base64");

/** Run the install script as the agent. Needs `as_agent`. */
const RUN_GH_INSTALL: readonly string[] = [
    'gh_setup="$(mktemp "$(printenv TMPDIR || echo /tmp)/polaris-gh.XXXXXX")" || gh_setup=""',
    'if [ -n "$gh_setup" ]; then',
    `  printf %s ${INSTALL_BASE64} | base64 -d > "$gh_setup"`,
    '  chmod 0644 "$gh_setup" 2>/dev/null || true',
    '  as_agent "sh \\"$gh_setup\\"" || echo "polaris: the GitHub CLI did not install; git still works"',
    '  rm -f "$gh_setup"',
    "fi"
];

/**
 * The same install, ahead of a session: what a spare runs while the message is
 * still being typed (see `SPARE_BOOT`), so the session that claims it finds the
 * release already in the kept home. Unconditional on a repository, because a
 * spare does not know yet whether it will have one; once per version per home.
 */
export const PREINSTALL_GH: readonly string[] = [
    "if ! command -v gh >/dev/null 2>&1; then",
    ...RUN_GH_INSTALL.map((line) => `  ${line}`),
    "fi"
];

/**
 * The boot's lines: only for a session with a repository and the credential
 * helper written, best effort throughout (the setup runs under `set -e`, and a
 * session without `gh` still has git). Needs `as_agent` and the helper from the
 * worktree preparation before it.
 */
export const INSTALL_GH: readonly string[] = [
    'if [ -n "$GITHUB_REPOSITORY" ] && [ -f "$POLARIS_STATE_DIR/git-credential.sh" ]; then',
    '  gh_real="$(command -v gh 2>/dev/null || true)"',
    '  if [ -z "$gh_real" ]; then',
    ...RUN_GH_INSTALL.map((line) => `    ${line}`),
    `    [ -x "${GH_DIR}/bin/gh" ] && gh_real="${GH_DIR}/bin/gh" || true`,
    "  fi",
    '  if [ -n "$gh_real" ]; then',
    '    mkdir -p "$POLARIS_STATE_DIR/bin"',
    `    printf %s ${WRAPPER_BASE64} | base64 -d > "$POLARIS_STATE_DIR/bin/gh"`,
    '    chmod 0755 "$POLARIS_STATE_DIR/bin/gh"',
    '    printf "%s\\n" "$gh_real" > "$POLARIS_STATE_DIR/gh-path"',
    '    if [ "$POLARIS_AS_ROOT" = "yes" ]; then',
    '      chown -R "$POLARIS_RUNAS" "$POLARIS_STATE_DIR/bin" "$POLARIS_STATE_DIR/gh-path" 2>/dev/null || true',
    "    fi",
    "  fi",
    "fi"
];
