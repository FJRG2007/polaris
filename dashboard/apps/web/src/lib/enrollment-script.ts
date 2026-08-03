/**
 * The enrollment script: what `curl ... | sudo sh` actually runs on the machine.
 *
 * It is generated per enrollment rather than served static because it carries the
 * public key and the claim URL for exactly one offer. Three rules shape it:
 *
 *   - POSIX `sh`, no bashisms. It has to run on a Debian box, an Alpine container
 *     host and a Mac, and none of those agree on which shells exist.
 *   - Idempotent. Running it twice is a normal thing for a human to do when the
 *     first run appeared to hang, and the second must not damage the first.
 *   - It says what it did. This runs as root on somebody's server; every step
 *     prints, and anything it could not do is reported rather than swallowed.
 *
 * Nothing secret is embedded. The public key is public, and the token only ever
 * buys one claim against this Polaris.
 */

import { ENROLLMENT_RETRY_HINT } from "@polaris/core";

/** Where a service account belongs on macOS: below the 501 the GUI hands out. */
const DARWIN_UID_FLOOR = 300;

/**
 * The one-liner an operator pastes. `sh` rather than `bash`, so it runs on a
 * minimal Alpine box and on a Mac without assuming a shell either one ships.
 *
 * Container-engine access and root are separate, visible arguments rather than
 * things the script decides for itself. Both are effectively root on the machine,
 * and neither is a thing to grant because a socket happened to be present or
 * because it would be convenient - they stay in the command where whoever runs it
 * can read what they are agreeing to.
 *
 * No `-f`. A refusal from this endpoint is a shell script that explains itself and
 * exits non-zero, and `-f` throws that body away: the operator gets `curl: (22)
 * ... 404` and a pipeline that still exits 0, so a spent command looks like a
 * successful run and the dialog waits forever. Errors curl raises itself are still
 * printed - that is what `-S` is for.
 */
export function enrollmentCommand(
    baseUrl: string,
    token: string,
    grantDocker = false,
    grantRoot = false
): string {
    const url = `${baseUrl}/api/servers/enroll/${token}`;
    const flags = [grantDocker ? "--docker" : null, grantRoot ? "--root" : null].filter(Boolean);
    return flags.length > 0 ? `curl -sSL ${url} | sudo sh -s -- ${flags.join(" ")}` : `curl -sSL ${url} | sudo sh`;
}

export interface EnrollmentScriptInput {
    /** The address the machine calls back on. Already the reachable one. */
    readonly baseUrl: string;
    readonly token: string;
    readonly username: string;
    /** The authorized_keys line, minus the restrictions this script adds. */
    readonly publicKey: string;
}

/**
 * Build the script. `publicKey` and `username` are Polaris-generated and
 * `baseUrl`/`token` are validated upstream, so none of them can carry shell
 * metacharacters; they are still single-quoted so that stays true if that ever
 * changes.
 */
export function enrollmentScript(input: EnrollmentScriptInput): string {
    return `#!/bin/sh
# Polaris server enrollment.
#
# This adds a dedicated, password-less login called '${input.username}' to this
# machine and authorizes one SSH key for it - the key Polaris generated and kept.
#
# On its own that login can do no more than any ordinary account. Two arguments
# widen it, and both are opt-in because both amount to root:
#   --docker  lets the login use the container engine, which on most systems is
#             equivalent to root
#   --root    lets the login run any command as root without a password, which
#             makes the key Polaris holds a root credential for this machine
#
# Everything it changes:
#   - the '${input.username}' user and its home directory
#   - ~${input.username}/.ssh/authorized_keys
#   - Remote Login, on macOS and only if it was off - nothing can connect until
#     it is on, which is the whole point of running this. Turning it on would
#     otherwise expose every account on the machine, so when this script is the
#     one that turns it on it also limits SSH to the '${input.username}' login.
#     A Mac that already had Remote Login on keeps whoever could use it.
#   - the docker group membership, only with --docker
#   - /etc/sudoers.d/${input.username}, only with --root
#
# Undo it with:  sudo userdel -r ${input.username}   (Linux)
#                sudo dscl . -delete /Users/${input.username}   (macOS)
#                sudo rm -f /etc/sudoers.d/${input.username}    (drops root only)
#                sudo systemsetup -setremotelogin off   (macOS, only if this
#                    script turned it on)
#                sudo dseditgroup -o delete com.apple.access_ssh   (macOS, puts
#                    SSH back to every account, only if this script limited it)

set -eu

POLARIS_URL=${shellQuote(input.baseUrl)}
POLARIS_TOKEN=${shellQuote(input.token)}
POLARIS_USER=${shellQuote(input.username)}
POLARIS_KEY=${shellQuote(input.publicKey)}
POLARIS_RETRY_HINT=${shellQuote(ENROLLMENT_RETRY_HINT)}
GRANT_DOCKER=0
GRANT_ROOT=0

for arg in "\$@"; do
    case "\$arg" in
        --docker) GRANT_DOCKER=1 ;;
        --root) GRANT_ROOT=1 ;;
        *) echo "polaris: unknown option \$arg" >&2; exit 2 ;;
    esac
done

say() { echo "polaris: \$1"; }

# Every abort in this script happens before the claim, so every one of them tells
# Polaris why on the way out - otherwise the dialog somebody is watching waits the
# command out and then blames the clock for a machine that ran it and refused.
# Reporting is folded into 'die' rather than left as a call to remember, so a stop
# added later cannot be a silent one.
#
# It carries a fixed code and never a message - Polaris holds the wording - and it
# spends nothing, so the same command still works. Best-effort in every direction:
# no answer, no Polaris, no network, no curl, and this changes neither what the
# script prints nor what it exits with.
die() {
    printf '{"reason":"%s"}' "\$1" | curl -sS -o /dev/null --max-time 10 -X POST \\
        -H 'content-type: application/json' \\
        --data-binary @- \\
        "\$POLARIS_URL/api/servers/enroll/\$POLARIS_TOKEN/refuse" >/dev/null 2>&1 || true
    echo "polaris: \$2" >&2
    exit 1
}

[ "\$(id -u)" = "0" ] || die not-root "run this with sudo"
command -v curl >/dev/null 2>&1 || die curl-missing "curl is required and was not found"

PLATFORM=\$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=\$(uname -m)
case "\$PLATFORM" in
    linux|darwin) ;;
    *) die unsupported-platform "\$PLATFORM is not supported yet - add this server by hand from the Servers app" ;;
esac

${createUserSection()}

${authorizeKeySection()}

${sshServiceSection()}

${dockerSection()}

${rootSection()}

${reportSection()}

${claimSection()}
`;
}

/** Create the login if it is missing, on whichever of the three user databases
 *  this machine has. An existing account is left exactly as it is. */
function createUserSection(): string {
    return `if id -u "\$POLARIS_USER" >/dev/null 2>&1; then
    say "the '\$POLARIS_USER' login already exists, leaving it alone"
elif [ "\$PLATFORM" = "darwin" ]; then
    # macOS has no useradd. Take the first free id above the service-account
    # floor so the account never collides with a person's.
    LAST_UID=\$(dscl . -list /Users UniqueID | awk -v floor=${DARWIN_UID_FLOOR} '\$2 >= floor && \$2 < 500 { print \$2 }' | sort -n | tail -1)
    NEW_UID=\$(( \${LAST_UID:-${DARWIN_UID_FLOOR - 1}} + 1 ))
    dscl . -create "/Users/\$POLARIS_USER"
    dscl . -create "/Users/\$POLARIS_USER" RealName "Polaris"
    dscl . -create "/Users/\$POLARIS_USER" UserShell /bin/sh
    dscl . -create "/Users/\$POLARIS_USER" UniqueID "\$NEW_UID"
    dscl . -create "/Users/\$POLARIS_USER" PrimaryGroupID 20
    dscl . -create "/Users/\$POLARIS_USER" NFSHomeDirectory "/Users/\$POLARIS_USER"
    # No password entry at all, so the account cannot be signed into interactively.
    dscl . -create "/Users/\$POLARIS_USER" IsHidden 1
    createhomedir -c -u "\$POLARIS_USER" >/dev/null 2>&1 || mkdir -p "/Users/\$POLARIS_USER"
    say "created the '\$POLARIS_USER' login (uid \$NEW_UID)"
elif command -v useradd >/dev/null 2>&1; then
    useradd --create-home --shell /bin/sh "\$POLARIS_USER"
    say "created the '\$POLARIS_USER' login"
elif command -v adduser >/dev/null 2>&1; then
    # BusyBox/Alpine: -D means "no password", which is what we want.
    adduser -D -s /bin/sh "\$POLARIS_USER"
    say "created the '\$POLARIS_USER' login"
else
    die no-user-tooling "this machine has no useradd or adduser; create a '\$POLARIS_USER' user and re-run"
fi

# Belt and braces: no password should ever authenticate this account.
if [ "\$PLATFORM" = "linux" ]; then
    passwd -l "\$POLARIS_USER" >/dev/null 2>&1 || usermod -L "\$POLARIS_USER" >/dev/null 2>&1 || true
fi

if [ "\$PLATFORM" = "darwin" ]; then
    HOME_DIR=\$(dscl . -read "/Users/\$POLARIS_USER" NFSHomeDirectory 2>/dev/null | awk '{ print \$2 }')
else
    HOME_DIR=\$(getent passwd "\$POLARIS_USER" 2>/dev/null | cut -d: -f6)
fi
[ -n "\${HOME_DIR:-}" ] || die no-home-directory "could not find the home directory of '\$POLARIS_USER'"`;
}

/** Install the key, without disturbing anything already authorized. */
function authorizeKeySection(): string {
    return `mkdir -p "\$HOME_DIR/.ssh"
touch "\$HOME_DIR/.ssh/authorized_keys"
# Forwarding an agent or an X display through this login is never something
# Polaris needs, and both are ways out of it. Port forwarding stays allowed:
# Polaris tunnels database connections over it.
ENTRY="no-agent-forwarding,no-X11-forwarding,no-user-rc \$POLARIS_KEY"
if grep -qF "\$POLARIS_KEY" "\$HOME_DIR/.ssh/authorized_keys" 2>/dev/null; then
    say "the key is already authorized"
else
    printf '%s\\n' "\$ENTRY" >> "\$HOME_DIR/.ssh/authorized_keys"
    say "authorized the Polaris key"
fi
chmod 700 "\$HOME_DIR/.ssh"
chmod 600 "\$HOME_DIR/.ssh/authorized_keys"
chown -R "\$POLARIS_USER" "\$HOME_DIR/.ssh"`;
}

/**
 * Make sure something will actually answer on the SSH port, and stop before the
 * claim when nothing will.
 *
 * A machine whose login is configured but whose SSH server is not running is the
 * one failure Polaris cannot diagnose from its end: the claim burns the token,
 * the outbound connect times out, and the operator is told to go and look at a
 * firewall that was never the problem. Catching it here leaves the token unspent,
 * so the same command works again once the server is on.
 *
 * The port is where this could go wrong in the other direction, so nothing here
 * trusts a single reading of the config. `sshd_config` names a port, the files it
 * `Include`s name one too - that is the default layout on Debian 12 and Ubuntu
 * 22.10+, and a hardened port usually lives in the dropped-in file rather than the
 * main one - and under systemd socket activation the config does not decide at all
 * and `ssh.socket` does. So every port any of them names is a candidate, 22 is
 * always one, and the one holding a reachable listener is the answer. That is also
 * what gets reported: an observed listener beats a parse, which is what the port
 * Polaris dials should have been all along.
 *
 * Reachable is part of the question rather than a refinement of it. A listener on
 * 127.0.0.1 answers the machine itself and nobody else, so counting it would let
 * the claim through and produce the firewall report this check exists to prevent.
 *
 * Refusing is reserved for the case where the check ran and no candidate had
 * anything reachable on it. A machine with neither `ss` nor `netstat` cannot answer
 * the question, and a wrong "nothing is listening" would strand an enrollment that
 * was fine.
 *
 * macOS is where this bites, because it ships with Remote Login off, so that one
 * is switched on rather than only reported. Stdin is closed for it because this
 * script IS stdin: anything that reads from it swallows the rest of the script.
 * The result is re-read rather than assumed - since Catalina the change is refused
 * unless the process running the command holds Full Disk Access, and `systemsetup`
 * reports that on stdout rather than in its exit code. That read has three answers,
 * not two: "off" is a reason to act, but a command that is missing or that says
 * something unrecognizable has told us nothing, and refusing on it would abort an
 * enrollment on a Mac whose sshd was running the whole time.
 */
function sshServiceSection(): string {
    return `# Every port sshd could be on, not just the first one named.
ssh_configured_ports() {
    _main=/etc/ssh/sshd_config
    [ -f "\$_main" ] || return 0
    _files=\$_main
    # Unquoted on purpose: each pattern is a glob, and a pattern matching nothing
    # stays literal and is dropped by the -f test.
    for _pattern in \$(awk 'tolower(\$1) == "include" { for (i = 2; i <= NF; i++) print \$i }' "\$_main" 2>/dev/null); do
        case "\$_pattern" in
            /*) ;;
            *) _pattern="/etc/ssh/\$_pattern" ;;
        esac
        for _file in \$_pattern; do
            if [ -f "\$_file" ]; then _files="\$_files \$_file"; fi
        done
    done
    for _file in \$_files; do
        awk 'tolower(\$1) == "port" && \$2 ~ /^[0-9]+\$/ { print \$2 }' "\$_file" 2>/dev/null || true
    done
}

# 22 is always a candidate: it is the default, and it is what sshd answers on when
# a socket unit rather than the config decides.
SSH_PORTS=""
for port in \$(ssh_configured_ports) 22; do
    case " \$SSH_PORTS " in
        *" \$port "*) ;;
        *) SSH_PORTS="\${SSH_PORTS:+\$SSH_PORTS }\$port" ;;
    esac
done
# What gets reported if nothing better is learned below: the first port the config
# names, or 22 when it names none.
SSH_PORT=\${SSH_PORTS%% *}

if [ "\$PLATFORM" = "darwin" ]; then
    ${darwinRemoteLoginSection()}
else
    ${linuxListenerSection()}
fi`;
}

/** Read Remote Login into yes/no/unknown. `systemsetup` puts the answer on stdout
 *  and keeps its exit code at 0 either way, so the text is what decides - and text
 *  that matches neither wording is an answer nobody got. The access list is read
 *  the same way and for the same reason: the three `dseditgroup` calls that narrow
 *  it can each fail on a managed Mac, and announcing a restriction that did not
 *  happen is worse than not restricting at all, because nobody goes to look. */
function darwinRemoteLoginSection(): string {
    return `read_remote_login() {
        REMOTE_LOGIN=unknown
        case "\$(systemsetup -getremotelogin 2>/dev/null | tr '[:upper:]' '[:lower:]')" in
            *"remote login: on"*) REMOTE_LOGIN=yes ;;
            *"remote login: off"*) REMOTE_LOGIN=no ;;
        esac
    }

    # yes/no/unknown again: dseditgroup reports membership on stdout, and a record
    # it cannot resolve or a tool that is not there says nothing either way.
    access_ssh_member() {
        case "\$(dseditgroup -o checkmember -m "\$1" -t "\$2" com.apple.access_ssh 2>/dev/null | tr '[:upper:]' '[:lower:]')" in
            yes*) echo yes ;;
            no*) echo no ;;
            *) echo unknown ;;
        esac
    }

    read_remote_login
    if [ "\$REMOTE_LOGIN" = "no" ]; then
        systemsetup -setremotelogin on </dev/null >/dev/null 2>&1 || true
        read_remote_login
        if [ "\$REMOTE_LOGIN" = "yes" ]; then
            # Remote Login was off, so nobody had SSH access here to lose. Turning
            # it on without this would hand the network every password-bearing
            # account on the machine, which is wider than anything the arguments
            # to this script can grant - so it is narrowed to the one login that
            # needs it. A Mac that already had Remote Login on never reaches here,
            # and its access list is left exactly as its operator set it.
            dseditgroup -o create -q com.apple.access_ssh >/dev/null 2>&1 || true
            dseditgroup -o edit -d everyone -t group com.apple.access_ssh >/dev/null 2>&1 || true
            dseditgroup -o edit -a "\$POLARIS_USER" -t user com.apple.access_ssh >/dev/null 2>&1 || true
            # Claimed only on proof: the login is in the group macOS gates SSH on,
            # and nothing says 'everyone' still is. Anything less and Remote Login
            # has just been switched on for the whole machine, which is the one
            # thing the operator has to be told rather than reassured about.
            if [ "\$(access_ssh_member "\$POLARIS_USER" user)" = "yes" ] \\
                && [ "\$(access_ssh_member everyone group)" != "yes" ]; then
                say "turned Remote Login on, limited to the '\$POLARIS_USER' login"
            else
                say "WARNING: turned Remote Login on, but SSH could not be limited to the '\$POLARIS_USER' login - every account on this machine can now be reached over SSH. Restrict it under System Settings > General > Sharing > Remote Login"
            fi
        else
            die remote-login-off "Remote Login is off, so nothing answers on port \$SSH_PORT. Turn it on in System Settings > General > Sharing, \$POLARIS_RETRY_HINT"
        fi
    else
        if [ "\$REMOTE_LOGIN" = "unknown" ]; then
            say "could not read whether Remote Login is on, so it was left alone"
        fi
        # Only matters when Remote Login is limited to named users. Adds, never
        # removes: this list is the operator's, and somebody else's access is not
        # this script's to withdraw.
        dseditgroup -o edit -a "\$POLARIS_USER" -t user com.apple.access_ssh >/dev/null 2>&1 || true
    fi`;
}

/**
 * Ask the machine what it is listening on, and let the answer pick the port.
 *
 * "Something is on that port" is not the question. An sshd bound to 127.0.0.1
 * answers this machine and nobody else, so accepting it would let the claim
 * through and land the operator on "could not reach the machine's SSH port from
 * here. Check the firewall between them" - the report this whole check exists to
 * stop producing. So the bind address has to be one Polaris could dial: a wildcard
 * or a real address, never loopback.
 */
function linuxListenerSection(): string {
    return `SSH_PROBE=none
    if command -v ss >/dev/null 2>&1; then
        SSH_PROBE=ss
    elif command -v netstat >/dev/null 2>&1; then
        SSH_PROBE=netstat
    fi

    # Both tools put the local address in the fourth column, in every spelling of a
    # wildcard they use ('0.0.0.0', '*', '[::]', ':::'). Only loopback is dropped.
    reachable_listener() {
        awk -v port="\$1" '
            \$4 ~ (":" port "\$") {
                addr = substr(\$4, 1, length(\$4) - length(port) - 1)
                if (addr ~ /^127\\./ || addr == "::1" || addr == "[::1]") next
                if (addr ~ /^\\[?::ffff:127\\./) next
                found = 1
            }
            END { exit found ? 0 : 1 }
        '
    }

    listening_on() {
        case "\$SSH_PROBE" in
            ss) ss -ltn 2>/dev/null | reachable_listener "\$1" ;;
            netstat) netstat -lnt 2>/dev/null | reachable_listener "\$1" ;;
            *) return 1 ;;
        esac
    }

    if [ "\$SSH_PROBE" = "none" ]; then
        # Neither tool, so the question cannot be asked. Reporting the configured
        # port and carrying on beats stranding an enrollment on a guess.
        say "no ss or netstat here, so whether anything is listening could not be checked"
    else
        SSH_LISTENING=no
        for port in \$SSH_PORTS; do
            if listening_on "\$port"; then
                SSH_PORT=\$port
                SSH_LISTENING=yes
                break
            fi
        done
        if [ "\$SSH_LISTENING" = "no" ]; then
            die ssh-not-listening "nothing Polaris could reach is listening on any port this machine's SSH server could be using (\$SSH_PORTS); start it, or bind it to something other than loopback, \$POLARIS_RETRY_HINT"
        fi
        say "an SSH server is listening on port \$SSH_PORT"
    fi`;
}

/** Container-engine access, only when it was asked for. */
function dockerSection(): string {
    return `DOCKER_PRESENT=false
if command -v docker >/dev/null 2>&1; then
    DOCKER_PRESENT=true
fi

if [ "\$GRANT_DOCKER" = "1" ]; then
    # Checked before "is one installed", because on a Mac the answer does not
    # change what happens: Docker Desktop runs per-user and the Polaris login
    # cannot reach it, so installing one would not help either.
    if [ "\$PLATFORM" = "darwin" ]; then
        say "WARNING: --docker does nothing on macOS; Docker Desktop is per-user, so jobs here run in a directory rather than a container"
    elif [ "\$DOCKER_PRESENT" != "true" ]; then
        say "WARNING: --docker was passed but no container engine is installed"
    else
        # Membership of this group is root-equivalent on most systems. It is here
        # because it was explicitly asked for, and it is printed for that reason.
        (getent group docker >/dev/null 2>&1 || groupadd docker) >/dev/null 2>&1 || true
        usermod -aG docker "\$POLARIS_USER" >/dev/null 2>&1 \\
            || addgroup "\$POLARIS_USER" docker >/dev/null 2>&1 \\
            || say "WARNING: could not add '\$POLARIS_USER' to the docker group"
        say "granted '\$POLARIS_USER' access to the container engine (root-equivalent)"
    fi
elif [ "\$DOCKER_PRESENT" = "true" ]; then
    say "a container engine is installed; re-run with --docker to let Polaris manage it"
fi`;
}

/**
 * Password-less sudo, only when it was asked for.
 *
 * This is the widest thing the script does, and the two ways it can go wrong are
 * both worse than not doing it:
 *
 *   - A sudoers file with a syntax error is refused by sudo *wholesale*, which
 *     takes root away from every account on the machine including the operator's.
 *     So it is written to a temporary path, validated with `visudo -c`, and only
 *     moved into place if it validates. A machine whose sudo cannot be repaired by
 *     the person standing in front of it is a far worse outcome than an enrollment
 *     that reports one missing capability.
 *   - Silently succeeding. What was granted is printed, and what was granted is
 *     also reported back, so Polaris records what the machine actually has rather
 *     than what it was asked for.
 */
function rootSection(): string {
    return `HAS_ROOT=false
if [ "\$GRANT_ROOT" = "1" ]; then
    if ! command -v sudo >/dev/null 2>&1; then
        say "WARNING: --root was passed but sudo is not installed"
    else
        SUDOERS="/etc/sudoers.d/\$POLARIS_USER"
        TMP="\$SUDOERS.polaris-tmp"
        mkdir -p /etc/sudoers.d
        printf '%s ALL=(ALL) NOPASSWD:ALL\\n' "\$POLARIS_USER" > "\$TMP"
        chmod 0440 "\$TMP"
        # visudo -c on the candidate file, never on the live one: an invalid
        # sudoers in place is what locks everybody out.
        if command -v visudo >/dev/null 2>&1 && ! visudo -c -f "\$TMP" >/dev/null 2>&1; then
            rm -f "\$TMP"
            say "WARNING: the sudo rule did not validate, so it was not installed"
        else
            mv "\$TMP" "\$SUDOERS"
            chown root "\$SUDOERS" 2>/dev/null || true
            say "granted '\$POLARIS_USER' password-less sudo (root on this machine)"
        fi
    fi
fi

# Asked rather than assumed: the grant above can be skipped, can fail to validate,
# or can already be there from an earlier run. This script is root, so it can ask
# sudo what a DIFFERENT account is allowed - which is the question that matters.
if command -v sudo >/dev/null 2>&1 && sudo -l -U "\$POLARIS_USER" >/dev/null 2>&1; then
    HAS_ROOT=true
elif [ -f "/etc/sudoers.d/\$POLARIS_USER" ]; then
    HAS_ROOT=true
fi`;
}

/** Everything Polaris is told about the machine, gathered here so the payload is
 *  assembled in one place and every field is visible. */
function reportSection(): string {
    return `HOSTNAME_VALUE=\$(hostname 2>/dev/null || echo "server")

# The machine commits to its host keys here, while this script still has root on
# it. Polaris refuses to trust any other key later, which is what stops something
# else on the network from answering in its place.
HOST_KEYS=""
collect_host_keys() {
    HOST_KEYS=""
    for pub in /etc/ssh/ssh_host_*_key.pub; do
        [ -f "\$pub" ] || continue
        line=\$(cut -d' ' -f1,2 < "\$pub")
        [ -n "\$line" ] || continue
        if [ -z "\$HOST_KEYS" ]; then HOST_KEYS="\\"\$line\\""; else HOST_KEYS="\$HOST_KEYS,\\"\$line\\""; fi
    done
}

collect_host_keys
if [ -z "\$HOST_KEYS" ]; then
    # A Mac that has never had Remote Login switched on has no host keys yet -
    # sshd mints them the first time it starts. Doing it here, the same way, lets
    # the machine commit to the keys it will still be answering with later:
    # 'ssh-keygen -A' only fills in what is missing and never replaces a key.
    command -v ssh-keygen >/dev/null 2>&1 \\
        || die no-ssh-host-keys "this machine has no SSH host keys and no ssh-keygen to make them; is an SSH server installed?"
    ssh-keygen -A >/dev/null 2>&1 || true
    collect_host_keys
    [ -n "\$HOST_KEYS" ] || die no-ssh-host-keys "this machine has no SSH host keys and they could not be generated; is an SSH server installed?"
    say "this machine had no SSH host keys yet; generated them"
fi

# Candidates only - Polaris prefers the address it sees this request come from.
if [ "\$PLATFORM" = "darwin" ]; then
    ADDR_LIST=\$(ifconfig 2>/dev/null | awk '/inet /&&\$2!="127.0.0.1"{ print \$2 }')
else
    ADDR_LIST=\$(ip -4 -o addr show scope global 2>/dev/null | awk '{ print \$4 }' | cut -d/ -f1)
    [ -n "\$ADDR_LIST" ] || ADDR_LIST=\$(hostname -I 2>/dev/null | tr ' ' '\\n')
fi
ADDRESSES=""
for addr in \$ADDR_LIST; do
    [ -n "\$addr" ] || continue
    if [ -z "\$ADDRESSES" ]; then ADDRESSES="\\"\$addr\\""; else ADDRESSES="\$ADDRESSES,\\"\$addr\\""; fi
done`;
}

/** Hand the report back. A failure here is the one the operator most needs to
 *  see, because the machine is already configured and only the call home broke. */
function claimSection(): string {
    return `say "telling Polaris about this machine..."
BODY=\$(printf '{"hostname":"%s","platform":"%s","arch":"%s","username":"%s","port":%s,"docker":%s,"root":%s,"hostKeys":[%s],"addresses":[%s]}' \\
    "\$HOSTNAME_VALUE" "\$PLATFORM" "\$ARCH" "\$POLARIS_USER" "\$SSH_PORT" "\$DOCKER_PRESENT" "\$HAS_ROOT" "\$HOST_KEYS" "\$ADDRESSES")

# No -f: a refusal from Polaris carries a body explaining itself, and -f would
# throw it away and leave the operator with nothing but an exit code.
RESPONSE=\$(printf '%s' "\$BODY" | curl -sS -X POST \\
    -H 'content-type: application/json' \\
    --data-binary @- \\
    "\$POLARIS_URL/api/servers/enroll/\$POLARIS_TOKEN/claim" 2>&1) || {
    echo "polaris: could not reach Polaris at \$POLARIS_URL" >&2
    echo "polaris: \$RESPONSE" >&2
    echo "polaris: the login is configured; generate a new command and run it again once the two can talk" >&2
    exit 1
}

case "\$RESPONSE" in
    *'"ok":true'*) say "done - this machine is now registered" ;;
    *) echo "polaris: Polaris refused the enrollment: \$RESPONSE" >&2; exit 1 ;;
esac`;
}

/** Single-quote for POSIX sh, closing and reopening around any embedded quote. */
function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
