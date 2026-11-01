/**
 * The scripts a machine runs to change its network, executed by a real shell in a
 * throwaway directory with systemd and the network tools stubbed: what is on disk
 * after each step is what decides whether a failed change can be undone.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import * as router from "@/lib/router/plan";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from "node:fs";

const PLAN = router.routerPlanSchema.parse({
    wans: [{ interface: "eth0", vlan: 20 }],
    lans: [
        {
            id: "0190f1c2-0000-7000-8000-000000000001",
            name: "Home",
            interface: "eth1",
            vlan: null,
            cidr: "10.77.0.0/24",
            address: "10.77.0.1",
            internet: true,
            isolated: false,
            reservations: []
        }
    ],
    forwards: []
});
const ACCESS = { management: "192.0.2.9", sshPort: 22 };
/** A stand-in for each tool the scripts call; `systemctl` answers from files. */
const STUBS: Record<string, string> = {
    systemctl: `#!/bin/sh
echo "systemctl $*" >> "$FAKE/calls"
case "$*" in
    *is-failed*) [ -f "$FAKE/failed" ] ;;
    *is-active*polaris-router-rollback*) [ -f "$FAKE/undoing" ] ;;
    *is-active*) [ ! -f "$FAKE/down" ] ;;
    *) exit 0 ;;
esac
`,
    "systemd-run": `#!/bin/sh
echo "systemd-run $*" >> "$FAKE/calls"
`,
    ip: `#!/bin/sh
echo "ip $*" >> "$FAKE/calls"
case "$*" in
    *"addr show"*) cat "$FAKE/addresses" 2>/dev/null ;;
esac
exit 0
`
};

let root = "";
/** A path as sh takes it: a Windows drive holds the colon PATH splits on. */
const posix = (path: string) => path.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1");
const dir = () => posix(join(root, "etc"));
const state = () => posix(join(root, "state"));

function local(script: string): string {
    return script
        .replaceAll(router.ROUTER_STATE_DIR, state())
        .replaceAll(router.ROUTER_DIR, dir())
        .replace(/\/etc\/systemd\/system\//g, `${dir()}-units-`);
}

function run(script: string): string {
    const path = posix(join(root, "bin"));
    const result = spawnSync("sh", ["-c", `PATH="${path}:$PATH"\n${local(script)}`], {
        encoding: "utf8",
        env: { ...process.env, FAKE: posix(root) }
    });
    return result.stdout.trim();
}

function stored(name: string): string {
    return readFileSync(join(root, "state", name), "utf8");
}

/** Lay out a new configuration the way the apply script does, then activate it. */
function activate(marker: string, applyId: string): void {
    mkdirSync(join(root, "etc.next"), { recursive: true });
    writeFileSync(join(root, "etc.next", "marker"), marker);
    mkdirSync(join(root, "state"), { recursive: true });
    const script = router.renderApply(PLAN, ACCESS, applyId);
    const parts = /activate\.sh' <<'POLARIS_ROUTER_EOF'\n([\s\S]*?)POLARIS_ROUTER_EOF/.exec(script);
    const rollback = /rollback\.sh' <<'POLARIS_ROUTER_EOF'\n([\s\S]*?)POLARIS_ROUTER_EOF/.exec(
        script
    );
    writeFileSync(join(root, "state", "rollback.sh"), local(rollback?.[1] ?? ""));
    run(parts?.[1] ?? "");
}

const live = () => readFileSync(join(root, "etc", "marker"), "utf8");
const rollBack = () => run(`/bin/sh ${state()}/rollback.sh`);

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-router-"));
    mkdirSync(join(root, "bin"));
    for (const [name, content] of Object.entries(STUBS)) {
        const file = join(root, "bin", name);
        writeFileSync(file, content);
        chmodSync(file, 0o755);
    }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("what a change leaves on the machine", () => {
    it("parses as shell, every one of them", () => {
        const scripts = [
            router.renderApply(PLAN, ACCESS, "one"),
            router.renderConfirm("one"),
            router.renderRollback("one"),
            router.renderUp(PLAN),
            router.renderDown(PLAN),
            router.renderLines(PLAN),
            router.renderWanWatch(PLAN),
            router.REMOVE_SCRIPT,
            router.PROBE_SCRIPT
        ];
        for (const script of scripts) {
            const checked = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
            expect(checked.status, checked.stderr).toBe(0);
        }
    });

    it("does not confirm on what ran before this change", () => {
        activate("good", "good-id");
        expect(run(router.renderConfirm("good-id"))).toBe("confirmed");
        expect(run(router.renderConfirm("next-id"))).toBe("waiting");
    });

    it("goes back to the confirmed configuration", () => {
        activate("good", "good-id");
        run(router.renderConfirm("good-id"));
        activate("bad", "bad-id");
        expect(live()).toBe("bad");
        rollBack();
        expect(live()).toBe("good");
        expect(stored("last").trim()).toBe("rolled-back");
    });

    it("keeps the last good configuration through a retry nobody confirmed", () => {
        activate("good", "good-id");
        run(router.renderConfirm("good-id"));
        activate("bad", "bad-id");
        activate("worse", "worse-id");
        rollBack();
        expect(live()).toBe("good");
    });

    it("leaves a confirmed configuration alone when told to go back too late", () => {
        activate("good", "good-id");
        run(router.renderConfirm("good-id"));
        expect(run(router.renderRollback("good-id"))).toBe("confirmed");
        expect(live()).toBe("good");
    });

    it("undoes a first change down to no configuration at all", () => {
        activate("first", "first-id");
        rollBack();
        expect(existsSync(join(root, "etc", "marker"))).toBe(false);
    });

    it("undoes one that failed to start in a unit that survives the connection", () => {
        activate("bad", "bad-id");
        writeFileSync(join(root, "failed"), "");
        expect(run(router.renderConfirm("bad-id"))).toBe("waiting");
        expect(readFileSync(join(root, "calls"), "utf8")).toContain(
            "--unit=polaris-router-rollback-now"
        );
    });

    it("neither confirms nor starts a second undo while one is running", () => {
        activate("new", "new-id");
        writeFileSync(join(root, "undoing"), "");
        expect(run(router.renderConfirm("new-id"))).toBe("waiting");
        expect(existsSync(join(root, "state", "unconfirmed"))).toBe(true);
        expect(run(router.renderRollback("new-id"))).toBe("waiting");
        expect(readFileSync(join(root, "calls"), "utf8")).not.toContain("systemd-run");
    });

    it("waits while a service is still coming up", () => {
        activate("new", "new-id");
        writeFileSync(join(root, "down"), "");
        expect(run(router.renderConfirm("new-id"))).toBe("waiting");
        expect(run(router.renderRollback("new-id"))).toBe("waiting");
    });
});

describe("a port on its own", () => {
    const plain = router.routerPlanSchema.parse({
        ...PLAN,
        wans: [{ interface: "eth0", vlan: null }]
    });
    const calls = () => {
        const path = join(root, "calls");
        return existsSync(path) ? readFileSync(path, "utf8") : "";
    };
    const withRun = (script: string) =>
        script
            .replaceAll("/run/", `${posix(root)}/run-`)
            .replaceAll("/var/lib/dhcp", `${posix(root)}/dhcp`)
            .replaceAll("/proc/", `${posix(root)}/proc/`);
    const stub = (name: string, content: string) => {
        const file = join(root, "bin", name);
        writeFileSync(file, content);
        chmodSync(file, 0o755);
    };
    const ownPid = () => join(root, "run-dhclient-polaris.eth0.pid");
    /** A process, as far as the scripts can tell, and the file naming it. */
    const liveAs = (name: string, pidFile: string) => {
        mkdirSync(join(root, "proc", "4242"), { recursive: true });
        writeFileSync(join(root, "proc", "4242", "comm"), `${name}
`);
        writeFileSync(pidFile, "4242");
    };
    const holdingAnAddress = () => {
        mkdirSync(join(root, "run-polaris-router"), { recursive: true });
        writeFileSync(join(root, "addresses"), "2: eth0 inet 192.0.2.10/24");
        stub("dhclient", `#!/bin/sh\necho "dhclient $*" >> "$FAKE/calls"\n`);
    };

    it("stops its own client and keeps the address and the file", () => {
        mkdirSync(join(root, "run-polaris-router"), { recursive: true });
        writeFileSync(ownPid(), "999999");
        run(withRun(router.renderDown(plain)));
        expect(calls()).not.toContain("flush dev eth0");
        expect(existsSync(ownPid())).toBe(true);
    });

    it("renews on the next start when its client is gone", () => {
        holdingAnAddress();
        writeFileSync(ownPid(), "999999");
        run(withRun(router.renderLines(plain)));
        expect(calls()).toContain("dhclient -4");
    });

    it("starts no second client while its own is alive", () => {
        holdingAnAddress();
        liveAs("dhclient", ownPid());
        run(withRun(router.renderLines(plain)));
        expect(calls()).not.toContain("dhclient -4");
    });

    it("starts none beside the system's own when the line has no address", () => {
        holdingAnAddress();
        rmSync(join(root, "addresses"));
        liveAs("dhclient", join(root, "run-dhclient.eth0.pid"));
        run(withRun(router.renderLines(plain)));
        expect(calls()).not.toContain("dhclient -4");
    });

    it("renews when the number in its file is now somebody else's", () => {
        holdingAnAddress();
        liveAs("nginx", ownPid());
        run(withRun(router.renderLines(plain)));
        expect(calls()).toContain("dhclient -4");
    });

    it("signals only what it checked is its client", () => {
        const down = router.renderDown(plain);
        expect(down).toContain('! running /run/dhclient-polaris.eth0.pid || kill "$(cat');
    });

    it("leaves an address it never asked for to the system", () => {
        holdingAnAddress();
        run(withRun(router.renderLines(plain)));
        expect(calls()).not.toContain("dhclient -4");
    });

    it("can still renew after the router is removed and set up again", () => {
        holdingAnAddress();
        writeFileSync(ownPid(), "999999");
        writeFileSync(join(root, "run-polaris-router", "wan"), "eth0");
        run(withRun(router.REMOVE_SCRIPT));
        expect(existsSync(join(root, "run-polaris-router", "wan"))).toBe(false);
        run(withRun(router.renderLines(plain)));
        expect(calls()).toContain("dhclient -4");
    });

    describe("a machine still holding the stop script of an earlier version", () => {
        const systemPid = () => join(root, "run-dhclient.eth0.pid");
        const systemPidInShell = () => posix(systemPid());
        const earlierStop = () => {
            writeFileSync(systemPid(), "999999");
            mkdirSync(join(root, "etc"), { recursive: true });
            writeFileSync(
                join(root, "etc", "down.sh"),
                [
                    "#!/bin/sh",
                    `if [ -f ${systemPidInShell()} ]; then`,
                    `    kill "$(cat ${systemPidInShell()})" 2>/dev/null`,
                    "    ip -4 addr flush dev eth0 2>/dev/null",
                    `    rm -f ${systemPidInShell()}`,
                    "fi",
                    "ip addr flush dev eth1 2>/dev/null",
                    "exit 0",
                    ""
                ].join("\n")
            );
        };

        beforeEach(() => {
            earlierStop();
            stub(
                "systemctl",
                `${STUBS.systemctl?.replace(
                    'case "$*" in',
                    'case "$*" in\n    stop*polaris-router.service*) /bin/sh "$FAKE/etc/down.sh" ;;'
                )}`
            );
        });

        const untouched = () => {
            expect(calls()).not.toContain("flush dev eth0");
            expect(calls()).toContain("ip addr flush dev eth1");
            expect(existsSync(systemPid())).toBe(true);
        };

        it("keeps the line's address through a change", () => {
            activate("next", "next-id");
            untouched();
        });

        it("keeps the line's address through going back", () => {
            activate("next", "next-id");
            earlierStop();
            rmSync(join(root, "calls"));
            rollBack();
            untouched();
        });

        it("keeps the line's address through removal", () => {
            run(router.REMOVE_SCRIPT);
            untouched();
        });
    });

    it("never touches a client the system started for the same port", () => {
        const down = router.renderDown(plain);
        expect(down).not.toContain("/run/dhclient.eth0.pid");
        expect(down).not.toContain("flush dev eth0");
    });

    it("gives a network plugged in late its address, once", () => {
        run(router.renderLines(plain));
        expect(calls()).toContain("ip addr add 10.77.0.1/24 dev eth1");
        rmSync(join(root, "calls"));
        writeFileSync(join(root, "addresses"), "3: eth1 inet 10.77.0.1/24");
        run(router.renderLines(plain));
        expect(calls()).not.toContain("ip addr add");
    });
});
