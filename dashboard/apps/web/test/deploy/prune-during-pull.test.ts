/**
 * A prune never runs while an image is being fetched on the same machine.
 *
 * The failure this pins, seen on every Places update for a month: the camera
 * relay and the vision worker deploy together, the relay is up in ten seconds
 * and hands back every image nothing is using - and the vision worker's image,
 * still being unpacked, is one nothing is using yet. The pull then fails with
 * "failed to Lchown ... no such file or directory" on a layer that was fine.
 *
 * What is asserted: a prune that is only tidying is skipped while a pull runs,
 * and sends nothing to the daemon; one that has to happen waits for the pull and
 * then runs; a pull that arrives while a prune waits goes after it; a machine is
 * only held by its own work; and a prune that waits too long gives up and lets
 * the queue behind it go.
 */

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const asked: string[] = [];
let pulls: PassThrough[] = [];

vi.mock("@polaris/hostd-client", () => ({
    HostdClient: class {
        async dockerRequest(method: string, path: string) {
            asked.push(`${method} ${path}`);
            return { status: 200, body: JSON.stringify({ SpaceReclaimed: 1000 }) };
        }
        async deployPull() {
            const stream = new PassThrough();
            pulls.push(stream);
            return stream;
        }
    }
}));

const lock = await import("@/lib/deploy/image-store-lock");
const { reclaimHostSpace } = await import("@/lib/deploy/host-space");
const { HostdPorts } = await import("@/lib/deploy/ports-hostd");

/** Let every pending promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Finish the n-th pull the way the daemon does when it worked. */
function finishPull(index = 0): void {
    pulls[index]?.end("[polaris:exit:0]\n");
}

beforeEach(() => {
    asked.length = 0;
    pulls = [];
});

afterEach(() => {
    vi.useRealTimers();
});

describe("a prune over a pull on the local machine", () => {
    it("is skipped while a pull runs, when it is only tidying, and removes nothing", async () => {
        const pulling = new HostdPorts().pull("ghcr.io/fjrg2007/polaris-vision:latest");
        await settle();
        await expect(reclaimHostSpace({ whenIdle: true })).rejects.toBeInstanceOf(lock.ImageStoreBusy);
        expect(await new HostdPorts().reclaimSpace({ whenIdle: true })).toBe(0);
        expect(asked).toEqual([]);
        finishPull();
        await pulling;
    });

    it("waits for the pull when it has to happen, then runs", async () => {
        const pulling = new HostdPorts().pull("ghcr.io/fjrg2007/polaris-vision:latest");
        await settle();
        const reclaiming = reclaimHostSpace();
        await settle();
        expect(asked).toEqual([]);
        finishPull();
        await pulling;
        expect(await reclaiming).toBe(2000);
        expect(asked).toHaveLength(2);
    });

    it("runs at once on an idle machine", async () => {
        expect(await reclaimHostSpace({ whenIdle: true })).toBe(2000);
        expect(asked).toHaveLength(2);
    });
});

describe("the lock itself", () => {
    it("holds a pull that arrives while a prune is waiting until the prune is done", async () => {
        const order: string[] = [];
        let releaseFirst!: () => void;
        const first = lock.withImageUse("m", () => new Promise<void>((resolve) => (releaseFirst = resolve)));
        const prune = lock.withImagePrune("m", async () => {
            order.push("prune");
        });
        const second = lock.withImageUse("m", async () => {
            order.push("second pull");
        });
        await settle();
        expect(order).toEqual([]);
        releaseFirst();
        await Promise.all([first, prune, second]);
        expect(order).toEqual(["prune", "second pull"]);
    });

    it("keeps machines apart", async () => {
        let release!: () => void;
        const pulling = lock.withImageUse(lock.sshMachine("10.0.0.2", 22), () => new Promise<void>((resolve) => (release = resolve)));
        await expect(lock.withImagePrune(lock.LOCAL_MACHINE, async () => "swept", { whenIdle: true })).resolves.toBe("swept");
        await expect(
            lock.withImagePrune(lock.sshMachine("10.0.0.2", 22), async () => "swept", { whenIdle: true })
        ).rejects.toBeInstanceOf(lock.ImageStoreBusy);
        release();
        await pulling;
    });

    it("gives up after waiting too long, and lets what queued behind it go", async () => {
        vi.useFakeTimers();
        let release!: () => void;
        const stuck = lock.withImageUse("slow", () => new Promise<void>((resolve) => (release = resolve)));
        // Caught as it is made: it rejects while the clock is being advanced.
        const prune = lock.withImagePrune("slow", async () => "swept", { waitMs: 1000 }).catch((error: unknown) => error);
        const queued = lock.withImageUse("slow", async () => "pulled");
        await vi.advanceTimersByTimeAsync(1500);
        expect(await prune).toBeInstanceOf(lock.ImageStoreBusy);
        await expect(queued).resolves.toBe("pulled");
        release();
        await stuck;
    });

    it("still sees a pull that was waiting on a prune once that prune is done", async () => {
        let releasePrune!: () => void;
        const prune = lock.withImagePrune("orphan", () => new Promise<void>((resolve) => (releasePrune = resolve)));
        await settle();
        let releasePull!: () => void;
        const pulling = lock.withImageUse("orphan", () => new Promise<void>((resolve) => (releasePull = resolve)));
        await settle();
        releasePrune();
        await prune;
        await settle();
        await expect(lock.withImagePrune("orphan", async () => "swept", { whenIdle: true })).rejects.toBeInstanceOf(
            lock.ImageStoreBusy
        );
        releasePull();
        await pulling;
    });

    it("keeps a prune off between one step and the next of the same hold", async () => {
        const order: string[] = [];
        let releaseBuild!: () => void;
        let pruning!: Promise<unknown>;
        const deploy = lock.withImageUse("span", async () => {
            await lock.withImageUse("span", () => new Promise<void>((resolve) => (releaseBuild = resolve)));
            order.push("built");
            await settle();
            await lock.withImageUse("span", async () => {
                order.push("pinned");
            });
        });
        await settle();
        pruning = lock.withImagePrune("span", async () => {
            order.push("prune");
        });
        await settle();
        releaseBuild();
        await Promise.all([deploy, pruning]);
        expect(order).toEqual(["built", "pinned", "prune"]);
    });

    it("lets a hold make room for itself without waiting on itself", async () => {
        const order: string[] = [];
        await lock.withImageUse("self", async () => {
            await lock.withImagePrune("self", async () => {
                order.push("tidy");
            }, { whenIdle: true });
            await lock.withImagePrune("self", async () => {
                order.push("rescue");
            }, { waitMs: 1000 });
            await lock.withImageUse("self", async () => {
                order.push("pull");
            });
        });
        expect(order).toEqual(["tidy", "rescue", "pull"]);
        await expect(lock.withImagePrune("self", async () => "swept", { whenIdle: true })).resolves.toBe("swept");
    });

    it("does not tidy over another hold on the machine from inside its own", async () => {
        let releaseOther!: () => void;
        const other = lock.withImageUse("two", () => new Promise<void>((resolve) => (releaseOther = resolve)));
        await settle();
        await lock.withImageUse("two", async () => {
            await expect(lock.withImagePrune("two", async () => "swept", { whenIdle: true })).rejects.toBeInstanceOf(
                lock.ImageStoreBusy
            );
        });
        releaseOther();
        await other;
    });

    it("lets go of the machine when the work fails", async () => {
        await expect(lock.withImageUse("m", async () => Promise.reject(new Error("pull failed")))).rejects.toThrow(
            "pull failed"
        );
        await expect(lock.withImagePrune("m", async () => "swept", { whenIdle: true })).resolves.toBe("swept");
    });
});
