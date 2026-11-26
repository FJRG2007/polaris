/**
 * A server's traffic, from the counters its probe reports.
 *
 * A probe used to add every interface up, container veths and bridges included.
 * A veth leaves with its container, so that total fell on every deploy, and a
 * fall was read as a counter starting again: everything the machine had moved
 * since boot landed in one tick, drawn as hundreds of MB/s (BUG-0055).
 */

import { describe, expect, it } from "vitest";
import { parseProbe } from "../../src/lib/server-probe";
import { advanceTraffic, machineTraffic } from "../../src/lib/metrics-traffic";

const GB = 1024 ** 3;

function interfaces(list: [string, number, number][]) {
    return machineTraffic({
        netRxBytes: null,
        netTxBytes: null,
        netInterfaces: list.map(([name, rx, tx]) => ({ name, rx, tx }))
    })!;
}

describe("machineTraffic", () => {
    it("keys each listed interface on its own", () => {
        const map = interfaces([
            ["eth0", 10, 20],
            ["ens3", 1, 2]
        ]);
        expect([...map.keys()]).toEqual(["if:eth0", "if:ens3"]);
    });

    it("falls back to the machine total from a probe that did not list interfaces", () => {
        const map = machineTraffic({ netRxBytes: 5, netTxBytes: 6 })!;
        expect([...map.entries()]).toEqual([["machine", { rx: 5, tx: 6 }]]);
    });

    it("has no traffic for a machine that reported none", () => {
        expect(machineTraffic({ netRxBytes: null, netTxBytes: null })).toBeNull();
    });
});

describe("advanceTraffic", () => {
    it("adds only what each interface moved since the last tick", () => {
        const subject = "host-steady";
        advanceTraffic(subject, interfaces([["eth0", 500 * GB, 400 * GB]]));
        const moved = advanceTraffic(subject, interfaces([["eth0", 500 * GB + 1000, 400 * GB + 50]]));
        expect(moved).toEqual({ rx: 1000n, tx: 50n });
    });

    it("counts nothing for an interface that disappears", () => {
        const subject = "host-veth-gone";
        advanceTraffic(
            subject,
            interfaces([
                ["eth0", 100, 100],
                ["ens4", 900 * GB, 900 * GB]
            ])
        );
        const moved = advanceTraffic(subject, interfaces([["eth0", 160, 110]]));
        expect(moved).toEqual({ rx: 60n, tx: 10n });
    });

    it("counts nothing for an interface seen for the first time", () => {
        const subject = "host-new-if";
        advanceTraffic(subject, interfaces([["eth0", 100, 100]]));
        const moved = advanceTraffic(
            subject,
            interfaces([
                ["eth0", 100, 100],
                ["ens5", 700 * GB, 700 * GB]
            ])
        );
        expect(moved).toEqual({ rx: 0n, tx: 0n });
    });

    it("takes an interface's own fall as that interface starting again", () => {
        const subject = "host-if-restart";
        advanceTraffic(subject, interfaces([["ppp0", 10_000, 10_000]]));
        const moved = advanceTraffic(subject, interfaces([["ppp0", 300, 200]]));
        expect(moved).toEqual({ rx: 300n, tx: 200n });
    });

    // The reported case: a total that falls because a part of it went away is not
    // a counter that started again, and must not land as everything since boot.
    it("counts nothing when a machine total falls", () => {
        const subject = "host-total";
        const total = (rx: number, tx: number) => machineTraffic({ netRxBytes: rx, netTxBytes: tx })!;
        advanceTraffic(subject, total(800 * GB, 800 * GB));
        const moved = advanceTraffic(subject, total(790 * GB, 795 * GB));
        expect(moved).toEqual({ rx: 0n, tx: 0n });
        const next = advanceTraffic(subject, total(790 * GB + 10, 795 * GB + 5));
        expect(next).toEqual({ rx: 10n, tx: 5n });
    });

    it("does not spike on the first tick after a probe starts listing interfaces", () => {
        const subject = "host-upgrade";
        advanceTraffic(subject, machineTraffic({ netRxBytes: 900 * GB, netTxBytes: 900 * GB })!);
        const moved = advanceTraffic(subject, interfaces([["eth0", 400 * GB, 400 * GB]]));
        expect(moved).toEqual({ rx: 0n, tx: 0n });
    });
});

describe("parseProbe interfaces", () => {
    it("reads each counted interface", () => {
        const metrics = parseProbe(
            ["netif=eth0\t1000\t2000", "netif=enp3s0\t123456789012\t3", "net_rx=123456790012", "net_tx=2003"].join(
                "\n"
            )
        );
        expect(metrics.netInterfaces).toEqual([
            { name: "eth0", rx: 1000, tx: 2000 },
            { name: "enp3s0", rx: 123456789012, tx: 3 }
        ]);
        expect(metrics.netRxBytes).toBe(123456790012);
    });

    it("skips an interface line it cannot read", () => {
        const metrics = parseProbe("netif=eth0\tnot-a-number\t2\nnetif=\t1\t2\n");
        expect(metrics.netInterfaces).toEqual([]);
    });
});
