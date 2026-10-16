/**
 * A dashboard started by an update overlaps the one it replaces, and must not close
 * out that one's live deploys as abandoned while it is still running them.
 */

import { describe, expect, it, vi } from "vitest";
import {
    othersAmong,
    whenAlone,
    afterPredecessor,
    predecessorRetired
} from "@/lib/deploy/dashboard-peers";

// No daemon to ask, as in the limited edition, which is never rolled over.
vi.mock("@polaris/hostd-client", () => ({
    HostdClient: class {
        dockerRequest(): Promise<never> {
            return Promise.reject(new Error("no daemon"));
        }
    }
}));

describe("othersAmong", () => {
    it("finds a second dashboard and ignores this one", () => {
        expect(othersAmong("self", [{ Id: "self" }, { Id: "previous" }])).toBe(true);
        expect(othersAmong("self", [{ Id: "self" }])).toBe(false);
        expect(othersAmong("self", [])).toBe(false);
    });
});

describe("whenAlone", () => {
    const instant = () => Promise.resolve();

    it("runs at once when this is the only dashboard", async () => {
        const work = vi.fn(async () => undefined);
        await whenAlone(work, { peers: async () => false, sleep: instant });
        expect(work).toHaveBeenCalledOnce();
    });

    it("runs at once when nobody can say, as before it asked", async () => {
        const work = vi.fn(async () => undefined);
        await whenAlone(work, { peers: async () => null, sleep: instant });
        expect(work).toHaveBeenCalledOnce();
    });

    it("waits while the previous dashboard is still serving, then runs", async () => {
        const answers = [true, true, false];
        const peers = vi.fn(async () => answers.shift() ?? false);
        const order: string[] = [];
        await whenAlone(
            async () => {
                order.push("work");
            },
            {
                peers,
                recheckMs: 10,
                sleep: async () => {
                    order.push("sleep");
                }
            }
        );
        expect(order).toEqual(["sleep", "sleep", "work"]);
        expect(peers).toHaveBeenCalledTimes(3);
    });

    it("goes ahead after the give-up window rather than never", async () => {
        const work = vi.fn(async () => undefined);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        await whenAlone(work, {
            peers: async () => true,
            recheckMs: 10,
            giveUpMs: 30,
            sleep: instant
        });
        expect(work).toHaveBeenCalledOnce();
        warn.mockRestore();
    });
});

describe("afterPredecessor", () => {
    it("is one wait for every boot task, and settles when nobody else can be asked", async () => {
        const first = afterPredecessor();
        expect(afterPredecessor()).toBe(first);
        await expect(first).resolves.toBeUndefined();
    });

    it("reads as retired once that wait has settled", async () => {
        await afterPredecessor();
        expect(predecessorRetired()).toBe(true);
    });
});
