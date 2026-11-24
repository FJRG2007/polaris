// @ts-check
/**
 * The Linux launcher: a shell script put where the packaged executable was,
 * which starts the real one (`polaris.bin`) beside it.
 *
 * Chromium sandboxes its renderers with unprivileged user namespaces, and falls
 * back to the setuid helper (`chrome-sandbox`) where the system forbids them -
 * Ubuntu 24.04 and later by default. The .deb installs that helper owned by root
 * with mode 4755, so an installed Polaris is sandboxed either way. An AppImage
 * cannot use it: it is mounted nosuid. Only where both ways are closed does the
 * launcher add --no-sandbox, since without it the app aborts before its first
 * window; everywhere the sandbox can run, it runs.
 */

const LINUX_LAUNCHER = [
    "#!/bin/sh",
    'self="$0"',
    'case "$self" in */*) ;; *) self="$(command -v -- "$self")" || self="$0";; esac',
    'dir="$(dirname "$(readlink -f "$self")")"',
    'helper="$dir/chrome-sandbox"',
    "namespaces_refused() {",
    '  { [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] &&',
    '    [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = "Y" ]; } ||',
    '  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ] ||',
    '  [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = "0" ]',
    "}",
    "setuid_helper_works() {",
    '  [ -z "${APPIMAGE:-}" ] && [ -u "$helper" ] && [ "$(stat -c %u -- "$helper" 2>/dev/null)" = "0" ] &&',
    '  ! { findmnt -n -o OPTIONS -T "$helper" 2>/dev/null | grep -qw nosuid; }',
    "}",
    "if namespaces_refused && ! setuid_helper_works; then",
    '  set -- --no-sandbox "$@"',
    "fi",
    'exec "$dir/polaris.bin" "$@"',
    ""
].join("\n");

module.exports = { LINUX_LAUNCHER };
