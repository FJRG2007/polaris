/**
 * Server templates, the part that needs no database or network: the two fixed
 * scripts that read and put back a server's state, the argument lists they are
 * given, and the comparison that turns what a server reported into drift.
 *
 * The scripts are constants. Everything a template holds reaches the server as a
 * positional argument (`sh -c SCRIPT name ARG...`), quoted word by word, and is
 * only ever expanded inside double quotes there - so no value is read as shell,
 * whatever it contains. Pure.
 */

import { createHash } from "node:crypto";
import { quoteArgv } from "@polaris/deploy";
import type { DriftItem, TemplateSpec } from "@polaris/core";

/** Reads each item and prints `@<n> <what it found>`, one line per item. */
export const CHECK_SCRIPT = `export LC_ALL=C
i=0
while [ "$#" -ge 3 ]; do
k="$1"; a="$2"; b="$3"; shift 3; i=$((i+1)); v=unknown
case "$k" in
pkg)
if command -v dpkg-query >/dev/null 2>&1; then
if dpkg-query -W -f='\${Status}' "$a" 2>/dev/null | grep -q ' installed$'; then v=installed; else v=absent; fi
elif command -v rpm >/dev/null 2>&1; then
if rpm -q "$a" >/dev/null 2>&1; then v=installed; else v=absent; fi
elif command -v apk >/dev/null 2>&1; then
if apk info -e "$a" >/dev/null 2>&1; then v=installed; else v=absent; fi
fi;;
svc)
if command -v systemctl >/dev/null 2>&1; then
v="$(systemctl is-active "$a" 2>/dev/null | head -n 1) $(systemctl is-enabled "$a" 2>/dev/null | head -n 1)"
fi;;
file)
if [ -f "$a" ]; then v="$(stat -c %a "$a" 2>/dev/null) $(sha256sum "$a" 2>/dev/null | cut -c1-64)"; elif [ ! -e "$a" ]; then v=absent; fi;;
sysctl)
r="$(sysctl -n "$a" 2>/dev/null | tr '\\t\\n' '  ')"; [ -n "$r" ] && v="=$r";;
user)
if id "$a" >/dev/null 2>&1; then v="=$(id -nG "$a" 2>/dev/null)"; else v=absent; fi;;
fw)
if command -v ufw >/dev/null 2>&1; then
s="$(ufw status 2>/dev/null)"
if [ -z "$s" ]; then v=unknown
elif printf '%s\\n' "$s" | grep -q '^Status: active'; then
if printf '%s\\n' "$s" | grep -Eq "^$a(/$b)?[[:space:]]+ALLOW"; then v=allow; else v=missing; fi
else v=inactive; fi
else v=noufw; fi;;
esac
printf '@%s %s\\n' "$i" "$v"
done`;

/** Puts each item back and prints `@<n> ok` or `@<n> fail`. Never turns a
 *  firewall on or removes anything: both can cut a server off. A file's content
 *  arrives on stdin, one base64 line per file in order, rather than on the
 *  command line, where every account on the machine could read it in `ps` and
 *  where it would run into the size of one SSH request. */
export const FIX_SCRIPT = `export LC_ALL=C DEBIAN_FRONTEND=noninteractive
i=0; updated=0
install_pkg() {
if command -v apt-get >/dev/null 2>&1; then
apt-get install -y -qq "$1" >/dev/null 2>&1 && return 0
[ "$updated" = 1 ] && return 1; updated=1
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq "$1" >/dev/null 2>&1
elif command -v dnf >/dev/null 2>&1; then dnf install -y -q "$1" >/dev/null 2>&1
elif command -v yum >/dev/null 2>&1; then yum install -y -q "$1" >/dev/null 2>&1
elif command -v apk >/dev/null 2>&1; then apk add --no-cache -q "$1" >/dev/null 2>&1
else return 1; fi
}
while [ "$#" -ge 3 ]; do
k="$1"; a="$2"; b="$3"; shift 3; i=$((i+1)); r=1
case "$k" in
pkg) install_pkg "$a" </dev/null && r=0;;
svc)
r=0
exec 3<&0 </dev/null
case "$b" in ?1) systemctl enable "$a" >/dev/null 2>&1 || r=1;; ?0) systemctl disable "$a" >/dev/null 2>&1 || r=1;; esac
case "$b" in 1?) systemctl start "$a" >/dev/null 2>&1 || r=1;; 0?) systemctl stop "$a" >/dev/null 2>&1 || r=1;; esac
exec 0<&3 3<&-;;
file)
c=""; IFS= read -r c || true; t="$a.polaris-tmp"
mkdir -p "$(dirname "$a")" && printf '%s' "$c" | base64 -d > "$t" && chmod "$b" "$t" && mv -f "$t" "$a" && r=0
[ "$r" = 0 ] || rm -f "$t";;
sysctl)
f=/etc/sysctl.d/90-polaris.conf
if sysctl -w "$a=$b" >/dev/null 2>&1; then
{ [ -f "$f" ] && awk -v k="$a" '$1 != k' "$f"; printf '%s = %s\\n' "$a" "$b"; } > "$f.polaris-tmp" && mv -f "$f.polaris-tmp" "$f" && r=0
fi;;
user)
r=0
id "$a" >/dev/null 2>&1 || useradd -m "$a" </dev/null >/dev/null 2>&1 || r=1
[ "$r" = 0 ] && [ -n "$b" ] && { usermod -aG "$b" "$a" </dev/null >/dev/null 2>&1 || r=1; };;
fw) ufw allow "$a/$b" </dev/null >/dev/null 2>&1 && r=0;;
esac
if [ "$r" = 0 ]; then printf '@%s ok\\n' "$i"; else printf '@%s fail\\n' "$i"; fi
done`;

/** One template item, flattened: its key and the three words a script reads. */
export interface PlanItem {
    readonly key: string;
    readonly name: string;
    readonly check: readonly [string, string, string];
    readonly fix: readonly [string, string, string];
    /** A file's content, base64, sent on stdin. */
    readonly payload?: string;
}

export function sha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Every item a template declares, in a fixed order. */
export function planItems(spec: TemplateSpec): PlanItem[] {
    const items: PlanItem[] = [];
    for (const name of spec.packages) {
        items.push({ key: `pkg:${name}`, name, check: ["pkg", name, "-"], fix: ["pkg", name, "-"] });
    }
    for (const svc of spec.services) {
        const flags = `${svc.running ? 1 : 0}${svc.enabled ? 1 : 0}`;
        items.push({ key: `svc:${svc.name}`, name: svc.name, check: ["svc", svc.name, "-"], fix: ["svc", svc.name, flags] });
    }
    for (const file of spec.files) {
        const payload = Buffer.from(file.content, "utf8").toString("base64");
        items.push({ key: `file:${file.path}`, name: file.path, check: ["file", file.path, "-"], fix: ["file", file.path, file.mode], payload });
    }
    for (const entry of spec.sysctl) {
        items.push({ key: `sysctl:${entry.key}`, name: entry.key, check: ["sysctl", entry.key, "-"], fix: ["sysctl", entry.key, entry.value] });
    }
    for (const user of spec.users) {
        const groups = user.groups.join(",");
        items.push({ key: `user:${user.name}`, name: user.name, check: ["user", user.name, "-"], fix: ["user", user.name, groups] });
    }
    for (const rule of spec.firewall) {
        const port = String(rule.port);
        items.push({ key: `fw:${port}/${rule.protocol}`, name: `${port}/${rule.protocol}`, check: ["fw", port, rule.protocol], fix: ["fw", port, rule.protocol] });
    }
    return items;
}

/** The one command line a script runs as: through password-less sudo unless
 *  the login already is root. */
export function scriptCommand(script: string, words: readonly string[], sudo: boolean): string {
    const argv = ["sh", "-c", script, "polaris-template", ...words];
    return quoteArgv(sudo ? ["sudo", "-n", ...argv] : argv);
}

/** `@<n> <value>` lines, by item number (1-based). */
export function parseReport(output: string): Map<number, string> {
    const found = new Map<number, string>();
    for (const line of output.split("\n")) {
        const match = /^@(\d+) (.*)$/.exec(line.replace(/\r$/, ""));
        if (match) found.set(Number(match[1]), match[2]!);
    }
    return found;
}

const ENABLED = new Set(["enabled", "enabled-runtime", "static", "alias", "generated", "indirect"]);

const squash = (text: string) => text.trim().replace(/\s+/g, " ");

/** Compare what the server reported against the template. */
export function computeDrift(spec: TemplateSpec, report: Map<number, string>): DriftItem[] {
    const drift: DriftItem[] = [];
    const items = planItems(spec);
    const unreadable = (item: PlanItem) => drift.push({ key: item.key, code: "unreadable", name: item.name, fixable: false });

    let n = 0;
    const next = () => report.get(++n);

    for (const name of spec.packages) {
        const item = items[n]!;
        const value = next();
        if (value === "installed") continue;
        if (value === "absent") drift.push({ key: item.key, code: "packageMissing", name, fixable: true });
        else unreadable(item);
    }
    for (const svc of spec.services) {
        const item = items[n]!;
        const value = next();
        if (!value || value === "unknown") {
            unreadable(item);
            continue;
        }
        const [active = "", enabled = ""] = value.split(" ");
        if (svc.running && active !== "active") drift.push({ key: item.key, code: "serviceStopped", name: svc.name, actual: active || undefined, fixable: true });
        if (!svc.running && active === "active") drift.push({ key: item.key, code: "serviceRunning", name: svc.name, fixable: true });
        if (svc.enabled && !ENABLED.has(enabled)) drift.push({ key: item.key, code: "serviceNotEnabled", name: svc.name, actual: enabled || undefined, fixable: true });
        if (!svc.enabled && enabled === "enabled") drift.push({ key: item.key, code: "serviceEnabled", name: svc.name, fixable: true });
    }
    for (const file of spec.files) {
        const item = items[n]!;
        const value = next();
        if (value === "absent") {
            drift.push({ key: item.key, code: "fileMissing", name: file.path, fixable: true });
            continue;
        }
        const match = value ? /^(\d{3,4}) ([0-9a-f]{64})$/.exec(value) : null;
        if (!match) {
            unreadable(item);
            continue;
        }
        if (match[2] !== sha256(file.content)) drift.push({ key: item.key, code: "fileContent", name: file.path, fixable: true });
        if (match[1] !== file.mode) drift.push({ key: item.key, code: "fileMode", name: file.path, expected: file.mode, actual: match[1], fixable: true });
    }
    for (const entry of spec.sysctl) {
        const item = items[n]!;
        const value = next();
        if (!value?.startsWith("=")) {
            unreadable(item);
            continue;
        }
        const actual = squash(value.slice(1));
        if (actual !== squash(entry.value)) drift.push({ key: item.key, code: "sysctlValue", name: entry.key, expected: squash(entry.value), actual, fixable: true });
    }
    for (const user of spec.users) {
        const item = items[n]!;
        const value = next();
        if (value === "absent") {
            drift.push({ key: item.key, code: "userMissing", name: user.name, fixable: true });
            continue;
        }
        if (!value?.startsWith("=")) {
            unreadable(item);
            continue;
        }
        const has = new Set(squash(value.slice(1)).split(" "));
        const missing = user.groups.filter((group) => !has.has(group));
        if (missing.length > 0) drift.push({ key: item.key, code: "userGroups", name: user.name, expected: missing.join(", "), fixable: true });
    }
    for (const _rule of spec.firewall) {
        const item = items[n]!;
        const value = next();
        if (value === "allow") continue;
        if (value === "missing") drift.push({ key: item.key, code: "firewallMissing", name: item.name, fixable: true });
        else if (value === "inactive") drift.push({ key: item.key, code: "firewallOff", name: item.name, fixable: false });
        else if (value === "noufw") drift.push({ key: item.key, code: "firewallAbsent", name: item.name, fixable: false });
        else unreadable(item);
    }
    return drift;
}

/** The fix words for the drift keys asked for, in template order. Keys that are
 *  not drift, or not fixable, are dropped: a fix only ever puts back what the
 *  last check found wrong. */
export function fixWords(spec: TemplateSpec, drift: readonly DriftItem[], keys?: readonly string[]): { keys: string[]; words: string[]; input: string } {
    const fixable = new Set(drift.filter((item) => item.fixable).map((item) => item.key));
    const wanted = keys ? new Set(keys) : null;
    const chosen = planItems(spec).filter((item) => fixable.has(item.key) && (!wanted || wanted.has(item.key)));
    const payloads = chosen.flatMap((item) => (item.payload === undefined ? [] : [item.payload]));
    return {
        keys: chosen.map((item) => item.key),
        words: chosen.flatMap((item) => [...item.fix]),
        input: payloads.map((line) => `${line}\n`).join("")
    };
}
