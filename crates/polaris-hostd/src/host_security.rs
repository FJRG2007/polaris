//! Host-level security work for the Security scans app: the hardening audit and
//! the automatic security updates switch.
//!
//! Neither fits a deploy spec - both need the host's root mounted, which a spec
//! may never ask for - so each is one fixed `docker run` built here from a
//! closed set of actions. Nothing in the request reaches the command line but
//! the action's name (and a package action's checked words, below), which picks
//! one of the scripts below; there is no shell
//! between this process and `docker`. A package action also takes one package
//! (and a rollback one version), validated here and passed to the script as its
//! own positional words, never spliced into it.
//!
//! The scripts are word for word the ones the dashboard runs over SSH on a
//! remote server (`apps/security-scans/src/model/specs.ts`); a dashboard test
//! reads this file and fails when the two drift.

use std::io::{self, Read};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// busybox and apk, pinned by digest (the multi-arch index of alpine 3.22).
pub const TOOLS_IMAGE: &str =
    "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8";

/// One name for every host action, so two can never run at once on a host.
pub const HOST_CONTAINER: &str = "polaris-secscan-host";

/// Most of what an action prints that is kept; a report is a few hundred KB.
pub const MAX_OUTPUT: usize = 4 * 1024 * 1024;

pub const AUDIT_SCRIPT: &str = r#"apk add --no-cache --quiet lynis >/dev/null 2>&1 || { echo POLARIS_NO_TOOL; exit 20; }; nice -n 19 lynis audit system --rootdir /host --quick --no-colors --no-log --report-file /tmp/report.dat >/dev/null 2>&1; [ -s /tmp/report.dat ] || exit 21; echo POLARIS_REPORT; cat /tmp/report.dat"#;

pub const UPDATES_STATUS_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; if command -v apt-get >/dev/null 2>&1; then if grep -qs 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades && dpkg -s unattended-upgrades >/dev/null 2>&1; then echo POLARIS_UPDATES=on; else echo POLARIS_UPDATES=off; fi; echo "POLARIS_PENDING=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep -c '^Inst ')"; echo "POLARIS_SECURITY=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst ' | grep -ci security)"; [ -f /var/run/reboot-required ] && echo POLARIS_REBOOT=required; echo POLARIS_HOLDS; apt-mark showhold 2>/dev/null | sed 's/^/POLARIS_HELD=/'; elif command -v dnf >/dev/null 2>&1; then if systemctl is-enabled dnf-automatic.timer >/dev/null 2>&1; then echo POLARIS_UPDATES=on; else echo POLARIS_UPDATES=off; fi; echo "POLARIS_PENDING=$(dnf -q -C check-update 2>/dev/null | grep -c '^[[:alnum:]]')"; echo "POLARIS_SECURITY=$(dnf -q -C check-update --security 2>/dev/null | grep -c '^[[:alnum:]]')"; command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1 || echo POLARIS_REBOOT=required; }; echo POLARIS_HOLDS; dnf -q -C versionlock list 2>/dev/null | awk '/^Package name: / {print "POLARIS_HELD=" $3; next} /^#/ || / / || NF == 0 {next} {n = split($0, a, "-"); if (n > 2) {s = a[1]; for (i = 2; i <= n - 2; i++) s = s "-" a[i]; print "POLARIS_HELD=" s}}'; else echo POLARIS_UPDATES=unsupported; fi; [ -f /run/systemd/shutdown/scheduled ] && echo "POLARIS_REBOOT_AT=$(sed -n 's/^USEC=//p' /run/systemd/shutdown/scheduled)"; true"#;

pub const UPDATES_ON_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; nice -n 10 apt-get update -qq >/dev/null && nice -n 10 apt-get install -y -qq unattended-upgrades >/dev/null && printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades && mkdir -p /etc/systemd/system/apt-daily-upgrade.timer.d && printf '[Timer]\nOnCalendar=\nOnCalendar=*-*-* 04:00\nRandomizedDelaySec=30m\n' > /etc/systemd/system/apt-daily-upgrade.timer.d/polaris.conf && { systemctl daemon-reload >/dev/null 2>&1 || true; } && echo POLARIS_UPDATES=on; elif command -v dnf >/dev/null 2>&1; then nice -n 10 dnf install -y -q dnf-automatic >/dev/null && sed -i -e 's/^upgrade_type *=.*/upgrade_type = security/' -e 's/^apply_updates *=.*/apply_updates = yes/' /etc/dnf/automatic.conf && mkdir -p /etc/systemd/system/dnf-automatic.timer.d && printf '[Timer]\nOnCalendar=\nOnCalendar=*-*-* 04:00\nRandomizedDelaySec=30m\n' > /etc/systemd/system/dnf-automatic.timer.d/polaris.conf && { systemctl daemon-reload >/dev/null 2>&1 || true; } && systemctl enable --now dnf-automatic.timer >/dev/null 2>&1 && echo POLARIS_UPDATES=on; else echo POLARIS_UPDATES=unsupported; fi"#;

pub const UPDATES_OFF_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; if command -v apt-get >/dev/null 2>&1; then printf 'APT::Periodic::Update-Package-Lists "0";\nAPT::Periodic::Unattended-Upgrade "0";\n' > /etc/apt/apt.conf.d/20auto-upgrades && echo POLARIS_UPDATES=off; elif command -v dnf >/dev/null 2>&1; then systemctl disable --now dnf-automatic.timer >/dev/null 2>&1; echo POLARIS_UPDATES=off; else echo POLARIS_UPDATES=unsupported; fi"#;

pub const REBOOT_SCHEDULE_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; if [ -f /var/run/reboot-required ] || { command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1; }; then shutdown -r 04:30 'Polaris: restarting at 04:30 to finish security updates' >/dev/null 2>&1 && echo POLARIS_REBOOT=scheduled; else echo POLARIS_REBOOT=none; fi; [ -f /run/systemd/shutdown/scheduled ] && echo "POLARIS_REBOOT_AT=$(sed -n 's/^USEC=//p' /run/systemd/shutdown/scheduled)"; true"#;

pub const REBOOT_CANCEL_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; shutdown -c 'Polaris: the restart was cancelled' >/dev/null 2>&1; echo POLARIS_REBOOT=cancelled"#;

pub const PACKAGES_FIX_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; nice -n 10 apt-get update -qq >/dev/null 2>&1; if ! command -v unattended-upgrade >/dev/null 2>&1; then echo POLARIS_FIX=unavailable; elif nice -n 10 unattended-upgrade >/dev/null 2>&1; then echo POLARIS_FIX=done; else echo POLARIS_FIX=failed; fi; [ -f /var/run/reboot-required ] && echo POLARIS_REBOOT=required; elif command -v dnf >/dev/null 2>&1; then if nice -n 10 dnf upgrade --security -y -q >/dev/null 2>&1; then echo POLARIS_FIX=done; else echo POLARIS_FIX=failed; fi; command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1 || echo POLARIS_REBOOT=required; }; else echo POLARIS_FIX=unsupported; fi; true"#;

pub const PACKAGE_VERSIONS_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; if command -v apt-get >/dev/null 2>&1; then dpkg -s "$1" 2>/dev/null | grep -q '^Status: install ok installed' || { echo POLARIS_PACKAGE=missing; exit 0; }; echo "POLARIS_INSTALLED=$(dpkg -s "$1" 2>/dev/null | sed -n 's/^Version: //p')"; apt-mark showhold 2>/dev/null | grep -qxF "$1" && echo POLARIS_KEPT=yes; apt-cache madison "$1" 2>/dev/null | awk -F'|' '{gsub(/ /, "", $2); if ($2 != "" && !seen[$2]++) print "POLARIS_VERSION=" $2}'; elif command -v dnf >/dev/null 2>&1; then rpm -q "$1" >/dev/null 2>&1 || { echo POLARIS_PACKAGE=missing; exit 0; }; echo "POLARIS_INSTALLED=$(rpm -q --qf '%|EPOCH?{%{EPOCH}:}:{}|%{VERSION}-%{RELEASE}' "$1" | head -n 1)"; dnf -q versionlock list 2>/dev/null | awk '/^Package name: / {print "POLARIS_HELD=" $3; next} /^#/ || / / || NF == 0 {next} {n = split($0, a, "-"); if (n > 2) {s = a[1]; for (i = 2; i <= n - 2; i++) s = s "-" a[i]; print "POLARIS_HELD=" s}}' | grep -qxF "POLARIS_HELD=$1" && echo POLARIS_KEPT=yes; dnf -q --showduplicates list "$1" 2>/dev/null | awk 'NF == 3 && !seen[$2]++ {print "POLARIS_VERSION=" $2}'; else echo POLARIS_PACKAGE=unsupported; fi; true"#;

pub const PACKAGE_HOLD_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; if command -v apt-get >/dev/null 2>&1; then dpkg -s "$1" 2>/dev/null | grep -q '^Status: install ok installed' || { echo POLARIS_HOLD=missing; exit 0; }; if apt-mark hold "$1" >/dev/null 2>&1; then echo POLARIS_HOLD=held; else echo POLARIS_HOLD=failed; fi; elif command -v dnf >/dev/null 2>&1; then rpm -q "$1" >/dev/null 2>&1 || { echo POLARIS_HOLD=missing; exit 0; }; if { dnf -q versionlock list >/dev/null 2>&1 || nice -n 10 dnf install -y -q 'dnf-command(versionlock)' >/dev/null 2>&1; } && dnf -q versionlock add "$1" >/dev/null 2>&1; then echo POLARIS_HOLD=held; else echo POLARIS_HOLD=failed; fi; else echo POLARIS_HOLD=unsupported; fi; true"#;

pub const PACKAGE_UNHOLD_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; if command -v apt-get >/dev/null 2>&1; then if apt-mark unhold "$1" >/dev/null 2>&1; then echo POLARIS_HOLD=released; else echo POLARIS_HOLD=failed; fi; elif command -v dnf >/dev/null 2>&1; then dnf -q versionlock delete "$1" >/dev/null 2>&1; if dnf -q versionlock list 2>/dev/null | awk '/^Package name: / {print "POLARIS_HELD=" $3; next} /^#/ || / / || NF == 0 {next} {n = split($0, a, "-"); if (n > 2) {s = a[1]; for (i = 2; i <= n - 2; i++) s = s "-" a[i]; print "POLARIS_HELD=" s}}' | grep -qxF "POLARIS_HELD=$1"; then echo POLARIS_HOLD=failed; else echo POLARIS_HOLD=released; fi; else echo POLARIS_HOLD=unsupported; fi; true"#;

pub const PACKAGE_ROLLBACK_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-cache madison "$1" 2>/dev/null | awk -F'|' '{gsub(/ /, "", $2); if ($2 != "" && !seen[$2]++) print "POLARIS_VERSION=" $2}' | grep -qxF "POLARIS_VERSION=$2" || { echo POLARIS_ROLLBACK=unavailable; exit 0; }; if nice -n 10 apt-get install -y -qq --no-remove --allow-downgrades -o Dpkg::Options::=--force-confold "$1=$2" >/dev/null 2>&1; then apt-mark hold "$1" >/dev/null 2>&1; echo POLARIS_ROLLBACK=done; else echo POLARIS_ROLLBACK=failed; fi; elif command -v dnf >/dev/null 2>&1; then dnf -q --showduplicates list "$1" 2>/dev/null | awk 'NF == 3 && !seen[$2]++ {print "POLARIS_VERSION=" $2}' | grep -qxF "POLARIS_VERSION=$2" || { echo POLARIS_ROLLBACK=unavailable; exit 0; }; if nice -n 10 dnf downgrade -y -q "$1-$2" >/dev/null 2>&1; then { dnf -q versionlock list >/dev/null 2>&1 || nice -n 10 dnf install -y -q 'dnf-command(versionlock)' >/dev/null 2>&1; }; dnf -q versionlock add "$1" >/dev/null 2>&1; echo POLARIS_ROLLBACK=done; else echo POLARIS_ROLLBACK=failed; fi; else echo POLARIS_ROLLBACK=unsupported; fi; true"#;

/// The host firewall: nftables table `inet polaris_host`, input only, default deny.
/// Status reads what listens and what the containers publish; apply loads a
/// rule set built from the ports it is given (plus every SSH listener it finds
/// itself) behind a 120 s systemd timer that undoes it, and only confirm - a
/// second, fresh call carrying the same apply id - keeps it and makes it the one
/// loaded at boot. The boot unit is Debian's own nftables.service ordering. An
/// active ufw or firewalld is turned off in favour of it, and back on when the
/// change rolls back before anything was confirmed or the firewall is turned off.
pub const FIREWALL_STATUS_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; D=/var/lib/polaris-firewall; if command -v nft >/dev/null 2>&1; then echo POLARIS_NFT=yes; nft list table inet polaris_router >/dev/null 2>&1 && echo POLARIS_ROUTER=yes; if nft list table inet polaris_host >/dev/null 2>&1; then if [ -f $D/pending ]; then echo POLARIS_FIREWALL=armed; else echo POLARIS_FIREWALL=on; fi; else echo POLARIS_FIREWALL=off; fi; else echo POLARIS_NFT=no; echo POLARIS_FIREWALL=off; fi; [ -f $D/allowed ] && sed 's/^/POLARIS_ALLOWED=/' $D/allowed; [ -f $D/replaced ] && echo "POLARIS_REPLACED=$(cat $D/replaced)"; if command -v ufw >/dev/null 2>&1 && grep -qs '^ENABLED=yes' /etc/ufw/ufw.conf; then echo POLARIS_OTHER=ufw; elif systemctl is-active --quiet firewalld 2>/dev/null; then echo POLARIS_OTHER=firewalld; fi; ip -o addr show 2>/dev/null | awk '{sub(/\/.*/, "", $4); print "POLARIS_ADDR=" $2 " " $4}'; command -v wg >/dev/null 2>&1 && wg show all listen-port 2>/dev/null | awk '{print "POLARIS_WG=" $2}'; command -v docker >/dev/null 2>&1 && docker ps -aq 2>/dev/null | head -n 500 | xargs -r docker inspect --format '{{.Name}}{{range $p, $b := .HostConfig.PortBindings}}{{range $b}} {{$p}}={{.HostPort}}{{end}}{{end}}' 2>/dev/null | sed 's/^\//POLARIS_BOUND=/'; ss -Htulnp 2>/dev/null | head -n 500 | while read -r p s q1 q2 l r u; do port=${l##*:}; n=$(echo "$u" | sed -n 's/^users:(("\([^"]*\)".*/\1/p'); pid=$(echo "$u" | sed -n 's/^users:(("[^"]*",pid=\([0-9]*\).*/\1/p'); c=-; if [ -n "$pid" ]; then id=$(grep -oE '(docker|libpod)[-/][0-9a-f]{64}' /proc/$pid/cgroup 2>/dev/null | head -n 1 | grep -oE '[0-9a-f]{64}'); [ -n "$id" ] && c=$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null | tr -d '/'); [ -n "$c" ] || c=-; fi; [ "$n" = systemd ] && n=$(systemctl list-sockets --no-legend 2>/dev/null | awk -v p="$port" '$1 ~ (":" p "$") {print $2; exit}'); echo "POLARIS_LISTEN=$p $port ${l%:*} ${n:--} $c"; done; true"#;

pub const FIREWALL_APPLY_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; D=/var/lib/polaris-firewall; id=$1; shift; if ! command -v nft >/dev/null 2>&1; then if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive nice -n 10 apt-get install -y -qq nftables >/dev/null 2>&1; elif command -v dnf >/dev/null 2>&1; then nice -n 10 dnf install -y -q nftables >/dev/null 2>&1; fi; fi; command -v nft >/dev/null 2>&1 || { echo POLARIS_FIREWALL=unavailable; exit 0; }; nft list table inet polaris_router >/dev/null 2>&1 && { echo POLARIS_FIREWALL=router; exit 0; }; mkdir -p $D && chmod 700 $D || { echo POLARIS_FIREWALL=failed; exit 0; }; for p in $(ss -Htlnp 2>/dev/null | grep '"sshd"' | awk '{for (i = 1; i <= NF; i++) if ($i ~ /:[0-9]+$/) {n = split($i, a, ":"); print a[n]; break}}') $(systemctl list-sockets --no-legend 2>/dev/null | awk '$2 == "ssh.socket" || $2 == "sshd.socket" {n = split($1, a, ":"); print a[n]}'); do set -- "$@" "tcp:$p"; done; printf '%s\n' "$@" | sort -u > $D/next.ports; T=$(sed -n 's/^tcp://p' $D/next.ports | sort -un | paste -sd, -); U=$(sed -n 's/^udp://p' $D/next.ports | sort -un | paste -sd, -); { printf '%s\n' 'table inet polaris_host {}' 'delete table inet polaris_host' 'table inet polaris_host {' 'chain input {' 'type filter hook input priority filter; policy drop;' 'ct state established,related accept' 'ct state invalid drop' 'iifname "lo" accept'; for i in docker br- veth virbr cni flannel kube tailscale zt wg tun tap podman lxcbr lxdbr vboxnet vmnet; do printf 'iifname "%s*" accept\n' "$i"; done; printf '%s\n' 'meta l4proto { icmp, ipv6-icmp } accept' 'udp sport 547 udp dport 546 accept' 'udp sport 67 udp dport 68 accept'; [ -n "$T" ] && printf 'tcp dport { %s } accept\n' "$T"; [ -n "$U" ] && printf 'udp dport { %s } accept\n' "$U"; printf '%s\n' '}' '}'; } > $D/next.nft; nft -c -f $D/next.nft >/dev/null 2>&1 || { echo POLARIS_FIREWALL=invalid; exit 0; }; printf '%s\n' '#!/bin/sh' 'D=/var/lib/polaris-firewall' 'nft delete table inet polaris_host 2>/dev/null' '[ -s $D/good.nft ] && nft -f $D/good.nft' 'if [ -f $D/replaced ] && [ ! -s $D/good.nft ]; then case $(cat $D/replaced) in ufw) ufw --force enable >/dev/null 2>&1 ;; firewalld) systemctl enable --now firewalld >/dev/null 2>&1 ;; esac; rm -f $D/replaced; fi' 'rm -f $D/pending' 'echo rolled-back > $D/ending' > $D/rollback.sh; printf '%s\n' '#!/bin/sh' 'D=/var/lib/polaris-firewall' 'if [ -f $D/pending ]; then /bin/sh $D/rollback.sh; elif [ -s $D/good.nft ]; then nft -f $D/good.nft; fi' > $D/boot.sh; printf '%s\n' '[Unit]' 'Description=Polaris host firewall' 'Wants=network-pre.target' 'Before=network-pre.target shutdown.target' 'Conflicts=shutdown.target' 'DefaultDependencies=no' 'RequiresMountsFor=/var/lib/polaris-firewall' '[Service]' 'Type=oneshot' 'RemainAfterExit=yes' 'ExecStart=/bin/sh /var/lib/polaris-firewall/boot.sh' '[Install]' 'WantedBy=sysinit.target' > /etc/systemd/system/polaris-firewall.service; systemctl daemon-reload >/dev/null 2>&1; systemctl enable polaris-firewall.service >/dev/null 2>&1; systemctl stop polaris-firewall-rollback.timer polaris-firewall-rollback.service >/dev/null 2>&1; systemctl reset-failed polaris-firewall-rollback.service >/dev/null 2>&1; rm -f $D/ending; echo "$id" > $D/pending; systemd-run --quiet --unit=polaris-firewall-rollback --timer-property=AccuracySec=1s --on-active=120 /bin/sh $D/rollback.sh >/dev/null 2>&1 || { rm -f $D/pending; echo POLARIS_FIREWALL=failed; exit 0; }; if command -v ufw >/dev/null 2>&1 && grep -qs '^ENABLED=yes' /etc/ufw/ufw.conf; then ufw disable >/dev/null 2>&1 && echo ufw > $D/replaced; elif systemctl is-active --quiet firewalld 2>/dev/null; then systemctl disable --now firewalld >/dev/null 2>&1 && echo firewalld > $D/replaced; fi; if nft -f $D/next.nft >/dev/null 2>&1; then echo POLARIS_FIREWALL=armed; else systemctl stop polaris-firewall-rollback.timer >/dev/null 2>&1; /bin/sh $D/rollback.sh; echo POLARIS_FIREWALL=failed; fi"#;

pub const FIREWALL_CONFIRM_SCRIPT: &str = r#"D=/var/lib/polaris-firewall; systemctl stop polaris-firewall-rollback.timer >/dev/null 2>&1; n=0; while systemctl is-active --quiet polaris-firewall-rollback.service 2>/dev/null && [ $n -lt 30 ]; do sleep 1; n=$((n + 1)); done; if [ -f $D/pending ] && [ "$(cat $D/pending)" = "$1" ] && nft list table inet polaris_host >/dev/null 2>&1; then cp $D/next.nft $D/good.nft && cp $D/next.ports $D/allowed && rm -f $D/pending && echo POLARIS_FIREWALL=confirmed; elif [ -f $D/ending ]; then echo POLARIS_FIREWALL=rolled-back; else echo POLARIS_FIREWALL=unknown; fi; true"#;

pub const FIREWALL_OFF_SCRIPT: &str = r#"D=/var/lib/polaris-firewall; systemctl stop polaris-firewall-rollback.timer polaris-firewall-rollback.service >/dev/null 2>&1; nft delete table inet polaris_host >/dev/null 2>&1; systemctl disable polaris-firewall.service >/dev/null 2>&1; rm -f /etc/systemd/system/polaris-firewall.service; systemctl daemon-reload >/dev/null 2>&1; case $(cat $D/replaced 2>/dev/null) in ufw) ufw --force enable >/dev/null 2>&1 ;; firewalld) systemctl enable --now firewalld >/dev/null 2>&1 ;; esac; rm -rf $D; echo POLARIS_FIREWALL=off"#;

/// SSH hardening: a drop-in, `/etc/ssh/sshd_config.d/00-polaris.conf`, that
/// turns password and keyboard-interactive sign-in off and keeps root to a key
/// (only when root could sign in with a password before). Sorted first so it
/// wins, since sshd keeps the first value it reads. Apply refuses when no
/// account that can log in has a key, checks the result with `sshd -t`, reads
/// the effective settings back with `sshd -T` (another file may still win),
/// and reloads sshd behind the same 120 s undo as the firewall: only a confirm
/// under the same id - which the dashboard sends over a fresh key login - keeps
/// it. A restart while armed undoes it before sshd starts.
pub const SSH_STATUS_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; D=/var/lib/polaris-ssh; F=/etc/ssh/sshd_config.d/00-polaris.conf; command -v sshd >/dev/null 2>&1 || { echo POLARIS_SSH=unavailable; exit 0; }; if [ -f $F ]; then if [ -f $D/pending ]; then echo POLARIS_SSH=armed; else echo POLARIS_SSH=on; fi; else echo POLARIS_SSH=off; fi; sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" || $1 == "permitrootlogin" || $1 == "kbdinteractiveauthentication" || $1 == "challengeresponseauthentication" || $1 == "pubkeyauthentication" {print "POLARIS_SSHD=" $1 " " $2}'; awk -F: '($3 == 0 || $3 >= 1000) && $7 !~ /(nologin|false|sync|halt|shutdown)$/ {print $1 " " $6}' /etc/passwd 2>/dev/null | head -n 200 | while read -r u h; do k=0; for f in "$h/.ssh/authorized_keys" "$h/.ssh/authorized_keys2"; do [ -f "$f" ] && k=$((k + $(grep -cE '^[^#[:space:]]' "$f" 2>/dev/null))); done; s=$(awk -F: -v u="$u" '$1 == u {print $2}' /etc/shadow 2>/dev/null); case "$s" in '' | '*'* | '!'*) p=no ;; *) p=yes ;; esac; echo "POLARIS_ACCOUNT=$u $k $p"; done; true"#;

pub const SSH_APPLY_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; D=/var/lib/polaris-ssh; F=/etc/ssh/sshd_config.d/00-polaris.conf; id=$1; command -v sshd >/dev/null 2>&1 || { echo POLARIS_SSH=unavailable; exit 0; }; keys=0; for h in $(awk -F: '($3 == 0 || $3 >= 1000) && $7 !~ /(nologin|false|sync|halt|shutdown)$/ {print $6}' /etc/passwd 2>/dev/null); do grep -qsE '^[^#[:space:]]' "$h/.ssh/authorized_keys" "$h/.ssh/authorized_keys2" && keys=1; done; [ $keys = 1 ] || { echo POLARIS_SSH=nokeys; exit 0; }; mkdir -p $D /etc/ssh/sshd_config.d && chmod 700 $D || { echo POLARIS_SSH=failed; exit 0; }; undo() { if [ -s $D/good.conf ]; then cp $D/good.conf $F; else rm -f $F; fi; }; r=$(sshd -T 2>/dev/null | awk '$1 == "permitrootlogin" {print $2}'); { printf '%s\n' '# Written by Polaris: sign in with a key only. Removed when SSH hardening is turned off.' 'PasswordAuthentication no' 'ChallengeResponseAuthentication no' 'PubkeyAuthentication yes'; [ "$r" = yes ] && echo 'PermitRootLogin prohibit-password'; } > $D/next.conf; cp $D/next.conf $F && chmod 644 $F || { undo; echo POLARIS_SSH=failed; exit 0; }; sshd -t >/dev/null 2>&1 || { undo; echo POLARIS_SSH=invalid; exit 0; }; sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" && $2 == "no" {p = 1} $1 == "permitrootlogin" && $2 != "yes" {r = 1} END {exit !(p && r)}' || { undo; echo POLARIS_SSH=overridden; exit 0; }; printf '%s\n' '#!/bin/sh' 'D=/var/lib/polaris-ssh' 'F=/etc/ssh/sshd_config.d/00-polaris.conf' 'if [ -s $D/good.conf ]; then cp $D/good.conf $F; else rm -f $F; fi' 'systemctl try-reload-or-restart ssh.service >/dev/null 2>&1 || systemctl try-reload-or-restart sshd.service >/dev/null 2>&1' 'rm -f $D/pending' 'echo rolled-back > $D/ending' > $D/rollback.sh; printf '%s\n' '[Unit]' 'Description=Polaris SSH hardening' 'Before=ssh.service sshd.service ssh.socket sshd.socket' 'RequiresMountsFor=/var/lib/polaris-ssh' '[Service]' 'Type=oneshot' 'ExecStart=/bin/sh -c "[ -f /var/lib/polaris-ssh/pending ] && /bin/sh /var/lib/polaris-ssh/rollback.sh; true"' '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/polaris-ssh.service; systemctl daemon-reload >/dev/null 2>&1; systemctl enable polaris-ssh.service >/dev/null 2>&1; systemctl stop polaris-ssh-rollback.timer polaris-ssh-rollback.service >/dev/null 2>&1; systemctl reset-failed polaris-ssh-rollback.service >/dev/null 2>&1; rm -f $D/ending; echo "$id" > $D/pending; systemd-run --quiet --unit=polaris-ssh-rollback --timer-property=AccuracySec=1s --on-active=120 /bin/sh $D/rollback.sh >/dev/null 2>&1 || { rm -f $D/pending; undo; echo POLARIS_SSH=failed; exit 0; }; if systemctl try-reload-or-restart ssh.service >/dev/null 2>&1 || systemctl try-reload-or-restart sshd.service >/dev/null 2>&1; then echo POLARIS_SSH=armed; else systemctl stop polaris-ssh-rollback.timer >/dev/null 2>&1; /bin/sh $D/rollback.sh; echo POLARIS_SSH=failed; fi"#;

pub const SSH_CONFIRM_SCRIPT: &str = r#"D=/var/lib/polaris-ssh; F=/etc/ssh/sshd_config.d/00-polaris.conf; systemctl stop polaris-ssh-rollback.timer >/dev/null 2>&1; n=0; while systemctl is-active --quiet polaris-ssh-rollback.service 2>/dev/null && [ $n -lt 30 ]; do sleep 1; n=$((n + 1)); done; if [ -f $D/pending ] && [ "$(cat $D/pending)" = "$1" ] && [ -f $F ]; then cp $F $D/good.conf && rm -f $D/pending && echo POLARIS_SSH=confirmed; elif [ -f $D/ending ]; then echo POLARIS_SSH=rolled-back; else echo POLARIS_SSH=unknown; fi; true"#;

pub const SSH_OFF_SCRIPT: &str = r#"D=/var/lib/polaris-ssh; systemctl stop polaris-ssh-rollback.timer polaris-ssh-rollback.service >/dev/null 2>&1; rm -f /etc/ssh/sshd_config.d/00-polaris.conf; systemctl try-reload-or-restart ssh.service >/dev/null 2>&1 || systemctl try-reload-or-restart sshd.service >/dev/null 2>&1; systemctl disable polaris-ssh.service >/dev/null 2>&1; rm -f /etc/systemd/system/polaris-ssh.service; systemctl daemon-reload >/dev/null 2>&1; rm -rf $D; echo POLARIS_SSH=off"#;

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HostAction {
    Audit,
    UpdatesStatus,
    UpdatesOn,
    UpdatesOff,
    RebootSchedule,
    RebootCancel,
    PackagesFix,
    PackageVersions,
    PackageHold,
    PackageUnhold,
    PackageRollback,
    FirewallStatus,
    FirewallApply,
    FirewallConfirm,
    FirewallOff,
    SshStatus,
    SshApply,
    SshConfirm,
    SshOff,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct HostSecurityRequest {
    pub action: HostAction,
    /// The one package a package action is about; refused on every other.
    #[serde(default)]
    pub package: Option<String>,
    /// The version a rollback goes to; refused on every other action.
    #[serde(default)]
    pub version: Option<String>,
    /// The id a firewall change is applied and then confirmed under.
    #[serde(default)]
    pub apply: Option<String>,
    /// The ports a firewall change leaves open, as `tcp:N` or `udp:N`.
    #[serde(default)]
    pub ports: Option<Vec<String>>,
}

/// Most ports one firewall change may name.
pub const MAX_FIREWALL_PORTS: usize = 512;

/// A firewall change's id: a UUID's alphabet, so it is one word with no sign.
pub fn valid_apply_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (8..=64).contains(&bytes.len())
        && bytes[0].is_ascii_hexdigit()
        && bytes.iter().all(|b| b.is_ascii_hexdigit() || *b == b'-')
}

/// One port to leave open: `tcp:` or `udp:` and a number from 1 to 65535
/// written with no leading zero.
pub fn valid_port_word(word: &str) -> bool {
    let Some(number) = word
        .strip_prefix("tcp:")
        .or_else(|| word.strip_prefix("udp:"))
    else {
        return false;
    };
    !number.is_empty()
        && number.len() <= 5
        && !number.starts_with('0')
        && number.bytes().all(|b| b.is_ascii_digit())
        && number
            .parse::<u32>()
            .is_ok_and(|n| (1..=65535).contains(&n))
}

/// A package name as dpkg and rpm write them: letters, digits and `+._-`,
/// never starting with a sign, so it can never read as an option.
pub fn valid_package(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"+._-".contains(b))
}

/// A package version as dpkg and rpm write them (epoch, `~` and `:` included).
pub fn valid_version(version: &str) -> bool {
    let bytes = version.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b".+~:_-".contains(b))
}

impl HostSecurityRequest {
    /// The positional arguments the action's script reads as `$1` and `$2`,
    /// or `None` when the request names a package or version the action does
    /// not take, leaves out one it needs, or names one that is not well formed.
    pub fn arguments(&self) -> Option<Vec<String>> {
        let takes_package = matches!(
            self.action,
            HostAction::PackageVersions
                | HostAction::PackageHold
                | HostAction::PackageUnhold
                | HostAction::PackageRollback
        );
        let takes_version = self.action == HostAction::PackageRollback;
        let takes_apply = matches!(
            self.action,
            HostAction::FirewallApply
                | HostAction::FirewallConfirm
                | HostAction::SshApply
                | HostAction::SshConfirm
        );
        let takes_ports = self.action == HostAction::FirewallApply;
        match (&self.apply, takes_apply) {
            (None, false) => {}
            (Some(id), true) if valid_apply_id(id) => {}
            _ => return None,
        }
        match (&self.ports, takes_ports) {
            (None, false) => {}
            (Some(ports), true)
                if !ports.is_empty()
                    && ports.len() <= MAX_FIREWALL_PORTS
                    && ports.iter().all(|p| valid_port_word(p)) => {}
            _ => return None,
        }
        match (&self.package, takes_package) {
            (None, false) => {}
            (Some(name), true) if valid_package(name) => {}
            _ => return None,
        }
        match (&self.version, takes_version) {
            (None, false) => {}
            (Some(version), true) if valid_version(version) => {}
            _ => return None,
        }
        Some(
            self.package
                .iter()
                .chain(self.version.iter())
                .chain(self.apply.iter())
                .chain(self.ports.iter().flatten())
                .cloned()
                .collect(),
        )
    }
}

/// The arguments after `docker` for an action. The audit sees the host
/// read-only and changes nothing; only the updates switch needs the host's root
/// writable, its process tree (to reach systemd) and its network. A package
/// action's name and version follow the script as its own arguments (`$0` is
/// "polaris"), so they reach the shell as words and are never read as code.
pub fn argv(action: HostAction, arguments: &[String]) -> Vec<String> {
    let mut args: Vec<&str> = vec![
        "run",
        "--rm",
        "--name",
        HOST_CONTAINER,
        "--cpu-shares",
        "64",
    ];
    match action {
        HostAction::Audit => args.extend([
            "--memory",
            "512m",
            "-v",
            "/:/host:ro",
            TOOLS_IMAGE,
            "/bin/sh",
            "-c",
            AUDIT_SCRIPT,
        ]),
        _ => {
            let script = match action {
                HostAction::UpdatesStatus => UPDATES_STATUS_SCRIPT,
                HostAction::UpdatesOn => UPDATES_ON_SCRIPT,
                HostAction::RebootSchedule => REBOOT_SCHEDULE_SCRIPT,
                HostAction::RebootCancel => REBOOT_CANCEL_SCRIPT,
                HostAction::PackagesFix => PACKAGES_FIX_SCRIPT,
                HostAction::PackageVersions => PACKAGE_VERSIONS_SCRIPT,
                HostAction::PackageHold => PACKAGE_HOLD_SCRIPT,
                HostAction::PackageUnhold => PACKAGE_UNHOLD_SCRIPT,
                HostAction::PackageRollback => PACKAGE_ROLLBACK_SCRIPT,
                HostAction::FirewallStatus => FIREWALL_STATUS_SCRIPT,
                HostAction::FirewallApply => FIREWALL_APPLY_SCRIPT,
                HostAction::FirewallConfirm => FIREWALL_CONFIRM_SCRIPT,
                HostAction::FirewallOff => FIREWALL_OFF_SCRIPT,
                HostAction::SshStatus => SSH_STATUS_SCRIPT,
                HostAction::SshApply => SSH_APPLY_SCRIPT,
                HostAction::SshConfirm => SSH_CONFIRM_SCRIPT,
                HostAction::SshOff => SSH_OFF_SCRIPT,
                _ => UPDATES_OFF_SCRIPT,
            };
            args.extend([
                "--privileged",
                "--pid",
                "host",
                "--network",
                "host",
                "-v",
                "/:/host",
                TOOLS_IMAGE,
                "chroot",
                "/host",
                "/bin/sh",
                "-c",
                script,
            ]);
        }
    }
    let mut args: Vec<String> = args.into_iter().map(String::from).collect();
    if !arguments.is_empty() {
        args.push("polaris".to_string());
        args.extend(arguments.iter().cloned());
    }
    args
}

static RUNNING: Mutex<()> = Mutex::new(());

/// Longest a host action may run before it is stopped, so a stuck package
/// manager or audit never holds the lock until the daemon restarts.
pub const ACTION_DEADLINE: Duration = Duration::from_secs(30 * 60);

/// Longest an image export may run before it is stopped.
pub const EXPORT_DEADLINE: Duration = Duration::from_secs(60 * 60);

const POLL: Duration = Duration::from_millis(250);

/// Wait for every child to exit by `deadline`. Past it, every one still
/// running is killed and the answer is `None`.
pub(crate) fn wait_all(
    children: &mut [&mut Child],
    deadline: Instant,
) -> io::Result<Option<Vec<ExitStatus>>> {
    let mut statuses: Vec<Option<ExitStatus>> = vec![None; children.len()];
    loop {
        for (child, status) in children.iter_mut().zip(statuses.iter_mut()) {
            if status.is_none() {
                *status = child.try_wait()?;
            }
        }
        if statuses.iter().all(Option::is_some) {
            return Ok(Some(statuses.into_iter().flatten().collect()));
        }
        if Instant::now() >= deadline {
            for child in children.iter_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Ok(None);
        }
        thread::sleep(POLL);
    }
}

/// The outcome of one action: docker's exit code and what it printed, capped.
#[derive(Debug)]
pub struct HostRun {
    pub exit_code: i32,
    pub output: String,
}

/// Why an action gave no outcome.
#[derive(Debug, PartialEq, Eq)]
pub enum RunError {
    Busy,
    TimedOut,
}

/// Run an action to the end. `Err(Busy)` when another one is still running,
/// `Err(TimedOut)` when it outlived `ACTION_DEADLINE` and was stopped.
pub fn run(action: HostAction, arguments: &[String]) -> io::Result<Result<HostRun, RunError>> {
    let Ok(_guard) = RUNNING.try_lock() else {
        return Ok(Err(RunError::Busy));
    };
    let deadline = Instant::now() + ACTION_DEADLINE;
    let mut child = Command::new("docker")
        .args(argv(action, arguments))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let reader = child.stdout.take().map(|stdout| {
        thread::spawn(move || {
            let mut output = Vec::new();
            let _ = stdout.take(MAX_OUTPUT as u64).read_to_end(&mut output);
            output
        })
    });
    let finished = wait_all(&mut [&mut child], deadline)?;
    if finished.is_none() {
        // Killing the client leaves the container running; it goes by name.
        let _ = docker_output(&rm_host_container_argv());
    }
    let output = reader.and_then(|r| r.join().ok()).unwrap_or_default();
    let Some(statuses) = finished else {
        return Ok(Err(RunError::TimedOut));
    };
    Ok(Ok(HostRun {
        exit_code: statuses[0].code().unwrap_or(-1),
        output: String::from_utf8_lossy(&output).into_owned(),
    }))
}

fn rm_host_container_argv() -> Vec<String> {
    ["rm", "-f", HOST_CONTAINER]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/* ------------------------------------------------------------------------ */
/* Image export, for scanning an image built on this host                    */
/* ------------------------------------------------------------------------ */

/// Prefix of the short-lived volume an image is exported into. Nothing else
/// may be named: the endpoint never creates or removes any other volume.
pub const EXPORT_VOLUME_PREFIX: &str = "polaris-secscan-image-";

/// Room kept free beyond the archive itself.
pub const EXPORT_HEADROOM: u64 = 1024 * 1024 * 1024;

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExportAction {
    Export,
    /// Copy the host's package database into the volume, for a scan of the
    /// host's own packages.
    Packages,
    Remove,
    List,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct ImageExportRequest {
    pub action: ExportAction,
    /// Required for export and remove; ignored by list.
    #[serde(default)]
    pub volume: String,
    #[serde(default)]
    pub image: Option<String>,
}

/// `polaris-secscan-image-` and 8 to 32 lowercase hex characters.
pub fn valid_export_volume(name: &str) -> bool {
    name.strip_prefix(EXPORT_VOLUME_PREFIX).is_some_and(|rest| {
        (8..=32).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// An image reference as the deploy spec accepts one, that can never read as
/// a flag.
pub fn valid_export_image(image: &str) -> bool {
    crate::deploy::valid_image(image) && !image.starts_with('-')
}

/// The free bytes `df -Pk` reports on its one filesystem line.
pub fn parse_df_free(output: &str) -> Option<u64> {
    let line = output.lines().nth(1)?;
    let kib: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    kib.checked_mul(1024)
}

/// Whether an archive of `size` bytes fits in `free` with the headroom kept.
pub fn has_room(size: u64, free: u64) -> bool {
    size.checked_add(EXPORT_HEADROOM)
        .is_some_and(|need| need <= free)
}

pub fn inspect_size_argv(image: &str) -> Vec<String> {
    ["image", "inspect", "--format", "{{.Size}}", image]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Mounts the export volume in a throwaway container; `tail` runs inside it.
pub fn volume_run_argv(volume: &str, interactive: bool, tail: &[&str]) -> Vec<String> {
    let mount = format!("{volume}:/in");
    let mut args = vec!["run", "--rm"];
    if interactive {
        args.push("-i");
    }
    args.extend(["--network", "none", "-v", &mount, TOOLS_IMAGE]);
    args.extend(tail);
    args.into_iter().map(String::from).collect()
}

pub const FREE_TAIL: &[&str] = &["df", "-Pk", "/in"];
pub const WRITE_TAIL: &[&str] = &["/bin/sh", "-c", "cat > /in/image.tar"];

/// Why an export did not happen.
#[derive(Debug, PartialEq, Eq)]
pub enum ExportError {
    Busy,
    NoImage,
    NoRoom,
    TimedOut,
    Failed,
}

fn docker_output(args: &[String]) -> io::Result<(bool, String)> {
    let out = Command::new("docker")
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    ))
}

/// Save `image` into `volume` as `/in/image.tar`, after checking it fits.
/// Shares the host action lock, so it never overlaps another host scan.
pub fn export_image(image: &str, volume: &str) -> Result<u64, ExportError> {
    let Ok(_guard) = RUNNING.try_lock() else {
        return Err(ExportError::Busy);
    };
    let deadline = Instant::now() + EXPORT_DEADLINE;
    let (ok, size) = docker_output(&inspect_size_argv(image)).map_err(|_| ExportError::Failed)?;
    let size: u64 = match size.trim().parse() {
        Ok(size) if ok => size,
        _ => return Err(ExportError::NoImage),
    };
    let (ok, df) = docker_output(&volume_run_argv(volume, false, FREE_TAIL))
        .map_err(|_| ExportError::Failed)?;
    match parse_df_free(&df) {
        Some(free) if ok && has_room(size, free) => {}
        Some(_) if ok => return Err(ExportError::NoRoom),
        _ => return Err(ExportError::Failed),
    }
    let save: Vec<String> = ["save", image].iter().map(|s| s.to_string()).collect();
    pipe_into_volume(&save, volume, WRITE_TAIL, deadline).map(|()| size)
}

/// Where a package manager keeps what is installed, relative to the host's
/// root, and the release file that names the distribution. Whatever exists is
/// copied; the scanner reads them as a directory, as it would an image's.
pub const PACKAGES_SCRIPT: &str = r#"cd /host || exit 21; set --; for p in etc/os-release usr/lib/os-release var/lib/dpkg/status var/lib/rpm usr/lib/sysimage/rpm lib/apk/db/installed; do [ -e "$p" ] && set -- "$@" "$p"; done; [ "$#" -gt 0 ] || exit 22; exec tar -cf - "$@""#;

/// Reads the host's root read-only, with no network, and prints a tar.
pub fn packages_argv() -> Vec<String> {
    [
        "run",
        "--rm",
        "--network",
        "none",
        "--cpu-shares",
        "64",
        "--memory",
        "256m",
        "-v",
        "/:/host:ro",
        TOOLS_IMAGE,
        "/bin/sh",
        "-c",
        PACKAGES_SCRIPT,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

pub const UNPACK_TAIL: &[&str] = &[
    "/bin/sh",
    "-c",
    "mkdir -p /in/root && tar -C /in/root -xf -",
];

/// Copy the host's package database into `volume` under `/in/root`. A few MB;
/// shares the host action lock like an image export.
pub fn export_packages(volume: &str) -> Result<(), ExportError> {
    let Ok(_guard) = RUNNING.try_lock() else {
        return Err(ExportError::Busy);
    };
    let deadline = Instant::now() + ACTION_DEADLINE;
    pipe_into_volume(&packages_argv(), volume, UNPACK_TAIL, deadline)
}

/// Run `docker <source>` and stream what it prints into a throwaway container
/// that has only `volume` mounted and runs `tail`.
fn pipe_into_volume(
    source: &[String],
    volume: &str,
    tail: &[&str],
    deadline: Instant,
) -> Result<(), ExportError> {
    let mut save = Command::new("docker")
        .args(source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ExportError::Failed)?;
    let stdout = save.stdout.take().ok_or(ExportError::Failed)?;
    let mut write = match Command::new("docker")
        .args(volume_run_argv(volume, true, tail))
        .stdin(Stdio::from(stdout))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(write) => write,
        Err(_) => {
            let _ = save.kill();
            let _ = save.wait();
            return Err(ExportError::Failed);
        }
    };
    match wait_all(&mut [&mut save, &mut write], deadline) {
        Ok(Some(statuses)) if statuses.iter().all(ExitStatus::success) => Ok(()),
        Ok(None) => Err(ExportError::TimedOut),
        _ => Err(ExportError::Failed),
    }
}

/// Remove an export volume and the archive in it.
pub fn list_exports_argv() -> Vec<String> {
    let filter = format!("name={EXPORT_VOLUME_PREFIX}");
    ["volume", "ls", "-q", "--filter", &filter]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Keep only names an export could have: the filter is a substring match.
pub fn export_names(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|name| valid_export_volume(name))
        .map(String::from)
        .collect()
}

/// The export volumes on this host, for the dashboard to sweep leftovers.
pub fn list_exports() -> Option<Vec<String>> {
    match docker_output(&list_exports_argv()) {
        Ok((true, out)) => Some(export_names(&out)),
        _ => None,
    }
}

pub fn remove_export(volume: &str) -> bool {
    let args: Vec<String> = ["volume", "rm", "-f", volume]
        .iter()
        .map(|s| s.to_string())
        .collect();
    docker_output(&args).map(|(ok, _)| ok).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn stops_children_past_the_deadline() {
        let mut quick = Command::new("true").spawn().unwrap();
        let done = wait_all(&mut [&mut quick], Instant::now() + Duration::from_secs(5)).unwrap();
        assert!(done.is_some_and(|s| s[0].success()));
        let mut stuck = Command::new("sleep").arg("30").spawn().unwrap();
        let started = Instant::now();
        let done = wait_all(
            &mut [&mut stuck],
            Instant::now() + Duration::from_millis(300),
        )
        .unwrap();
        assert!(done.is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(stuck.try_wait().unwrap().is_some());
    }

    #[test]
    fn lists_only_export_volumes() {
        let out =
            "polaris-secscan-image-0123abcd\nx-polaris-secscan-image-0123abcd\npolaris-abc_data\n";
        assert_eq!(export_names(out), vec!["polaris-secscan-image-0123abcd"]);
        assert_eq!(
            list_exports_argv().last().map(String::as_str),
            Some("name=polaris-secscan-image-")
        );
        let list: ImageExportRequest = serde_json::from_str(r#"{"action":"list"}"#).unwrap();
        assert_eq!(list.action, ExportAction::List);
    }

    #[test]
    fn export_volume_names_are_confined() {
        assert!(valid_export_volume("polaris-secscan-image-0123abcd"));
        assert!(!valid_export_volume("polaris-secscan-image-0123ABCD"));
        assert!(!valid_export_volume("polaris-secscan-image-123"));
        assert!(!valid_export_volume("polaris-abc_data"));
        assert!(!valid_export_volume("polaris-secscan-image-0123abcd/../x"));
    }

    #[test]
    fn export_images_cannot_be_flags_or_shell() {
        assert!(valid_export_image("polaris-0123abcd:build-7"));
        assert!(valid_export_image("ghcr.io/acme/app@sha256:abc"));
        assert!(!valid_export_image("-o=/etc/passwd"));
        assert!(!valid_export_image("x; rm -rf /"));
        assert!(!valid_export_image(""));
    }

    #[test]
    fn reads_free_space_and_keeps_headroom() {
        let df = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 50 2097152 50% /in\n";
        assert_eq!(parse_df_free(df), Some(2 * 1024 * 1024 * 1024));
        assert_eq!(parse_df_free("garbage"), None);
        assert!(has_room(1024, 2 * 1024 * 1024 * 1024));
        assert!(!has_room(1024 * 1024 * 1024 + 1, 2 * 1024 * 1024 * 1024));
        assert!(!has_room(u64::MAX, u64::MAX));
    }

    #[test]
    fn export_containers_have_no_network_and_only_the_volume() {
        let args = volume_run_argv("polaris-secscan-image-0123abcd", true, WRITE_TAIL);
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"none".to_string()));
        assert!(args.contains(&"polaris-secscan-image-0123abcd:/in".to_string()));
        assert!(!args.iter().any(|a| a.contains("docker.sock")));
        assert_eq!(
            inspect_size_argv("img:1").last().map(String::as_str),
            Some("img:1")
        );
    }

    #[test]
    fn package_listing_reads_the_host_read_only_with_no_network() {
        let args = packages_argv();
        assert!(args.contains(&"/:/host:ro".to_string()));
        assert!(args.contains(&"none".to_string()));
        assert!(!args.contains(&"--privileged".to_string()));
        assert_eq!(args.last().map(String::as_str), Some(PACKAGES_SCRIPT));
        let ok: ImageExportRequest = serde_json::from_str(
            r#"{"action":"packages","volume":"polaris-secscan-image-0123abcd"}"#,
        )
        .unwrap();
        assert_eq!(ok.action, ExportAction::Packages);
    }

    #[test]
    fn export_requests_are_closed() {
        let ok: ImageExportRequest = serde_json::from_str(
            r#"{"action":"export","volume":"polaris-secscan-image-0123abcd","image":"x:1"}"#,
        )
        .unwrap();
        assert_eq!(ok.action, ExportAction::Export);
        assert!(serde_json::from_str::<ImageExportRequest>(
            r#"{"action":"export","volume":"v","image":"x","cmd":"y"}"#
        )
        .is_err());
    }

    #[test]
    fn parses_only_known_actions() {
        let ok: HostSecurityRequest = serde_json::from_str(r#"{"action":"updates-on"}"#).unwrap();
        assert_eq!(ok.action, HostAction::UpdatesOn);
        assert!(serde_json::from_str::<HostSecurityRequest>(r#"{"action":"shell"}"#).is_err());
        assert!(
            serde_json::from_str::<HostSecurityRequest>(r#"{"action":"audit","cmd":"x"}"#).is_err()
        );
    }

    #[test]
    fn audit_is_read_only_and_unprivileged() {
        let args = argv(HostAction::Audit, &[]);
        assert!(args.contains(&"/:/host:ro".to_string()));
        assert!(!args.contains(&"--privileged".to_string()));
        assert_eq!(args.last().map(String::as_str), Some(AUDIT_SCRIPT));
    }

    #[test]
    fn updates_switch_runs_the_matching_script_in_the_host_root() {
        for (action, script) in [
            (HostAction::UpdatesStatus, UPDATES_STATUS_SCRIPT),
            (HostAction::UpdatesOn, UPDATES_ON_SCRIPT),
            (HostAction::UpdatesOff, UPDATES_OFF_SCRIPT),
            (HostAction::RebootSchedule, REBOOT_SCHEDULE_SCRIPT),
            (HostAction::RebootCancel, REBOOT_CANCEL_SCRIPT),
            (HostAction::PackagesFix, PACKAGES_FIX_SCRIPT),
            (HostAction::PackageVersions, PACKAGE_VERSIONS_SCRIPT),
            (HostAction::PackageHold, PACKAGE_HOLD_SCRIPT),
            (HostAction::PackageUnhold, PACKAGE_UNHOLD_SCRIPT),
            (HostAction::PackageRollback, PACKAGE_ROLLBACK_SCRIPT),
        ] {
            let args = argv(action, &[]);
            assert!(args.contains(&"--privileged".to_string()));
            let chroot = args.iter().position(|a| a == "chroot").unwrap();
            assert_eq!(args[chroot + 1], "/host");
            assert_eq!(args.last().map(String::as_str), Some(script));
        }
    }

    #[test]
    fn scripts_hold_no_control_characters() {
        for script in [
            AUDIT_SCRIPT,
            UPDATES_STATUS_SCRIPT,
            UPDATES_ON_SCRIPT,
            UPDATES_OFF_SCRIPT,
            REBOOT_SCHEDULE_SCRIPT,
            REBOOT_CANCEL_SCRIPT,
            PACKAGES_FIX_SCRIPT,
            PACKAGES_SCRIPT,
            PACKAGE_VERSIONS_SCRIPT,
            PACKAGE_HOLD_SCRIPT,
            PACKAGE_UNHOLD_SCRIPT,
            PACKAGE_ROLLBACK_SCRIPT,
            FIREWALL_STATUS_SCRIPT,
            FIREWALL_APPLY_SCRIPT,
            FIREWALL_CONFIRM_SCRIPT,
            FIREWALL_OFF_SCRIPT,
        ] {
            assert!(!script.bytes().any(|b| b < 0x20 || b == 0x7f));
        }
    }

    fn request(json: &str) -> Option<Vec<String>> {
        serde_json::from_str::<HostSecurityRequest>(json)
            .ok()?
            .arguments()
    }

    #[test]
    fn package_actions_take_one_well_formed_package_and_only_they_do() {
        assert_eq!(
            request(r#"{"action":"package-hold","package":"openssl"}"#),
            Some(vec!["openssl".to_string()])
        );
        assert_eq!(
            request(
                r#"{"action":"package-rollback","package":"libssl3","version":"1:3.0.15-1~deb12u1"}"#
            ),
            Some(vec![
                "libssl3".to_string(),
                "1:3.0.15-1~deb12u1".to_string()
            ])
        );
        assert_eq!(request(r#"{"action":"updates-on"}"#), Some(vec![]));
        for bad in [
            r#"{"action":"package-hold"}"#,
            r#"{"action":"package-hold","package":"-y"}"#,
            r#"{"action":"package-hold","package":"a;reboot"}"#,
            r#"{"action":"package-hold","package":"a b"}"#,
            r#"{"action":"package-hold","package":"$(id)"}"#,
            r#"{"action":"package-hold","package":"a\nb"}"#,
            r#"{"action":"package-hold","package":""}"#,
            r#"{"action":"package-hold","package":"openssl","version":"1.0"}"#,
            r#"{"action":"package-rollback","package":"openssl"}"#,
            r#"{"action":"package-rollback","package":"openssl","version":"1.0 && reboot"}"#,
            r#"{"action":"package-rollback","package":"openssl","version":"-1"}"#,
            r#"{"action":"updates-on","package":"openssl"}"#,
            r#"{"action":"audit","version":"1"}"#,
        ] {
            assert_eq!(request(bad), None, "{bad}");
        }
        assert!(!valid_package(&"a".repeat(129)));
    }

    #[test]
    fn package_arguments_follow_the_script_as_their_own_words() {
        let args = argv(
            HostAction::PackageRollback,
            &["libssl3".to_string(), "3.0.15-1".to_string()],
        );
        let script = args
            .iter()
            .position(|a| a == PACKAGE_ROLLBACK_SCRIPT)
            .unwrap();
        assert_eq!(&args[script - 1], "-c");
        assert_eq!(&args[script + 1..], ["polaris", "libssl3", "3.0.15-1"]);
        for script in [
            PACKAGE_VERSIONS_SCRIPT,
            PACKAGE_HOLD_SCRIPT,
            PACKAGE_UNHOLD_SCRIPT,
            PACKAGE_ROLLBACK_SCRIPT,
        ] {
            // Outside the single-quoted awk and sed programs, the words are only
            // ever read inside double quotes, never spliced into a bare word.
            let shell: String = script.split('\'').step_by(2).collect();
            assert!(!shell.contains(" $1") && !shell.contains(" $2"));
        }
    }

    #[test]
    fn firewall_actions_take_an_apply_id_and_well_formed_ports_only() {
        let id = "0f8c2a4e-1b2c-4d5e-8f90-123456789abc";
        assert_eq!(request(r#"{"action":"firewall-status"}"#), Some(vec![]));
        assert_eq!(request(r#"{"action":"firewall-off"}"#), Some(vec![]));
        assert_eq!(
            request(&format!(
                r#"{{"action":"firewall-apply","apply":"{id}","ports":["tcp:22","udp:7882"]}}"#
            )),
            Some(vec![
                id.to_string(),
                "tcp:22".to_string(),
                "udp:7882".to_string()
            ])
        );
        assert_eq!(
            request(&format!(
                r#"{{"action":"firewall-confirm","apply":"{id}"}}"#
            )),
            Some(vec![id.to_string()])
        );
        // An apply needs both, a confirm only the id, and nothing else takes either.
        assert_eq!(
            request(&format!(r#"{{"action":"firewall-apply","apply":"{id}"}}"#)),
            None
        );
        assert_eq!(
            request(r#"{"action":"firewall-apply","ports":["tcp:22"]}"#),
            None
        );
        assert_eq!(
            request(&format!(
                r#"{{"action":"firewall-apply","apply":"{id}","ports":[]}}"#
            )),
            None
        );
        assert_eq!(
            request(&format!(
                r#"{{"action":"firewall-confirm","apply":"{id}","ports":["tcp:22"]}}"#
            )),
            None
        );
        assert_eq!(
            request(&format!(r#"{{"action":"updates-on","apply":"{id}"}}"#)),
            None
        );
        assert_eq!(
            request(r#"{"action":"firewall-status","ports":["tcp:22"]}"#),
            None
        );
        for bad in ["-rf", "x; reboot", "0f8c2a4e 1b2c", "short", ""] {
            assert_eq!(
                request(&format!(
                    r#"{{"action":"firewall-confirm","apply":"{bad}"}}"#
                )),
                None,
                "{bad}"
            );
        }
        for bad in [
            "tcp:0",
            "tcp:65536",
            "tcp:022",
            "sctp:22",
            "tcp:22;",
            "tcp:",
            "udp:-1",
            "tcp:2 2",
        ] {
            assert_eq!(
                request(&format!(
                    r#"{{"action":"firewall-apply","apply":"{id}","ports":["{bad}"]}}"#
                )),
                None,
                "{bad}"
            );
        }
        let many: Vec<String> = (1..=MAX_FIREWALL_PORTS + 1)
            .map(|n| format!(r#""tcp:{n}""#))
            .collect();
        assert_eq!(
            request(&format!(
                r#"{{"action":"firewall-apply","apply":"{id}","ports":[{}]}}"#,
                many.join(",")
            )),
            None
        );
    }

    #[test]
    fn firewall_runs_in_the_host_root_and_never_loads_a_change_before_its_undo_is_armed() {
        let args = argv(
            HostAction::FirewallApply,
            &["abcdef12".to_string(), "tcp:22".to_string()],
        );
        assert!(args.contains(&"--privileged".to_string()));
        assert!(args.contains(&FIREWALL_APPLY_SCRIPT.to_string()));
        assert_eq!(&args[args.len() - 3..], ["polaris", "abcdef12", "tcp:22"]);
        let arm = FIREWALL_APPLY_SCRIPT
            .find("systemd-run --quiet --unit=polaris-firewall-rollback")
            .unwrap();
        let load = FIREWALL_APPLY_SCRIPT
            .rfind("if nft -f $D/next.nft")
            .unwrap();
        let replace = FIREWALL_APPLY_SCRIPT.find("ufw disable").unwrap();
        assert!(arm < replace && replace < load);
        // Only a confirm makes a change the one loaded at boot.
        assert!(
            !FIREWALL_APPLY_SCRIPT.contains("$D/good.nft &&")
                && !FIREWALL_APPLY_SCRIPT.contains("cp $D/next.nft")
        );
        assert!(FIREWALL_CONFIRM_SCRIPT.contains("cp $D/next.nft $D/good.nft"));
        // The router's own table is never stacked on.
        assert!(FIREWALL_APPLY_SCRIPT.contains("nft list table inet polaris_router"));
    }

    #[test]
    fn ssh_actions_take_an_apply_id_only_where_a_change_is_confirmed() {
        let id = "0f8c2a4e-1b2c-4d5e-8f90-123456789abc";
        assert_eq!(request(r#"{"action":"ssh-status"}"#), Some(vec![]));
        assert_eq!(request(r#"{"action":"ssh-off"}"#), Some(vec![]));
        for action in ["ssh-apply", "ssh-confirm"] {
            assert_eq!(
                request(&format!(r#"{{"action":"{action}","apply":"{id}"}}"#)),
                Some(vec![id.to_string()])
            );
            assert_eq!(request(&format!(r#"{{"action":"{action}"}}"#)), None);
            assert_eq!(
                request(&format!(
                    r#"{{"action":"{action}","apply":"{id}","ports":["tcp:22"]}}"#
                )),
                None
            );
            assert_eq!(
                request(&format!(r#"{{"action":"{action}","apply":"x; reboot"}}"#)),
                None
            );
        }
        assert_eq!(
            request(&format!(r#"{{"action":"ssh-status","apply":"{id}"}}"#)),
            None
        );
    }

    #[test]
    fn ssh_hardening_is_checked_before_sshd_reloads_and_undone_unless_confirmed() {
        let args = argv(HostAction::SshApply, &["abcdef12".to_string()]);
        assert!(args.contains(&SSH_APPLY_SCRIPT.to_string()));
        assert_eq!(&args[args.len() - 2..], ["polaris", "abcdef12"]);
        let keys = SSH_APPLY_SCRIPT.find("POLARIS_SSH=nokeys").unwrap();
        let check = SSH_APPLY_SCRIPT.find("sshd -t >/dev/null").unwrap();
        let effective = SSH_APPLY_SCRIPT.find("POLARIS_SSH=overridden").unwrap();
        let arm = SSH_APPLY_SCRIPT
            .find("systemd-run --quiet --unit=polaris-ssh-rollback")
            .unwrap();
        let reload = SSH_APPLY_SCRIPT
            .rfind("if systemctl try-reload-or-restart")
            .unwrap();
        assert!(keys < check && check < effective && effective < arm && arm < reload);
        // Root is only ever narrowed, never opened: the line is written only
        // when root could already sign in with a password.
        assert!(SSH_APPLY_SCRIPT
            .contains("[ \"$r\" = yes ] && echo 'PermitRootLogin prohibit-password'"));
        // Only a confirm makes it the one kept.
        assert!(!SSH_APPLY_SCRIPT.contains("$D/good.conf &&"));
        assert!(SSH_CONFIRM_SCRIPT.contains("cp $F $D/good.conf"));
        for script in [
            SSH_STATUS_SCRIPT,
            SSH_APPLY_SCRIPT,
            SSH_CONFIRM_SCRIPT,
            SSH_OFF_SCRIPT,
        ] {
            assert!(!script.bytes().any(|b| b < 0x20 || b == 0x7f));
        }
    }
}
