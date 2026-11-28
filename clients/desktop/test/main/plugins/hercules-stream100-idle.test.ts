import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/** The Stream 100 plugin's idle screen: the timer, the figures it reads and how it says them. */
const entry = createRequire(import.meta.url)(fileURLToPath(new URL("../../../../device-plugins/hercules-stream100/any/main.cjs", import.meta.url))) as {
    run(options: unknown): void;
    idleAfterMs(values: unknown): number;
    sameReport(a: Uint8Array | null, b: Uint8Array | null): boolean;
    parseNetDev(text: string): { received: number; sent: number; };
    createStats(deps: unknown): { read(now: number): Stats; reset(): void; };
    formatIdle(stats: Stats, locale: string, date: Date): { clock: string; rows: { label: string; value: string; percent: number | null; }[]; };
};

type Stats = { cpu: number | null; memory: { used: number; total: number; } | null; disk: { used: number; total: number; } | null; network: { down: number; up: number; } | null; };

const GB = 1024 ** 3;
const NET_DEV = [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0",
    "  eth0: 1000 10 0 0 0 0 0 0 400 5 0 0 0 0 0 0",
    " wlan0: 24 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0"
].join("\n");

function cpus(busy: number, idle: number) {
    return [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];
}

describe("Stream 100 idle screen", () => {
    it("waits the chosen seconds, never by default, capped at ten minutes", () => {
        expect(entry.idleAfterMs({})).toBe(0);
        expect(entry.idleAfterMs({ idleAfter: 0 })).toBe(0);
        expect(entry.idleAfterMs({ idleAfter: 30 })).toBe(30_000);
        expect(entry.idleAfterMs({ idleAfter: 9_999 })).toBe(600_000);
        expect(entry.idleAfterMs({ idleAfter: "x" })).toBe(0);
    });

    it("counts a touch only when a report differs from the one before", () => {
        expect(entry.sameReport(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
        expect(entry.sameReport(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
        expect(entry.sameReport(null, Uint8Array.of(1))).toBe(false);
    });

    it("reads the processor between two looks, memory, disk now and then, and the network on Linux only", () => {
        expect(entry.parseNetDev(NET_DEV)).toEqual({ received: 1024, sent: 500 });
        let times = cpus(100, 900);
        let net = NET_DEV;
        const statfs = vi.fn(() => ({ blocks: 100, bsize: GB, bavail: 25 }));
        const os = { cpus: () => times, totalmem: () => 16 * GB, freemem: () => 4 * GB };
        const stats = entry.createStats({ os, statfs, readNetDev: () => net, platform: "linux", systemDisk: "/" });
        expect(stats.read(0)).toEqual({ cpu: null, memory: { used: 12 * GB, total: 16 * GB }, disk: { used: 75 * GB, total: 100 * GB }, network: null });
        times = cpus(400, 1_600);
        net = NET_DEV.replace("eth0: 1000", "eth0: 3048");
        const second = stats.read(1_000);
        expect(second.cpu).toBe(30);
        expect(second.network).toEqual({ down: 2048, up: 0 });
        expect(statfs).toHaveBeenCalledTimes(1);
        stats.read(31_000);
        expect(statfs).toHaveBeenCalledTimes(2);
        const windows = entry.createStats({ os, statfs, readNetDev: () => { throw new Error("no such file"); }, platform: "win32", systemDisk: "C:\\" });
        expect(windows.read(0).network).toBeNull();
    });

    it("says the figures in the reader's language, short enough for the screen", () => {
        const page = entry.formatIdle({ cpu: 7, memory: { used: 7.9 * GB, total: 16 * GB }, disk: { used: 120 * GB, total: 500 * GB }, network: { down: 1.5 * 1024 ** 2, up: 300 * 1024 } }, "es-ES", new Date(2026, 10, 28, 9, 5));
        expect(page.clock).toBe("09:05");
        expect(page.rows).toEqual([
            { label: "CPU", value: "7%", percent: 7 },
            { label: "RAM", value: "7.9/16 GB", percent: 49 },
            { label: "Disco", value: "120/500 GB", percent: 24 },
            { label: "Red", value: "1.5M/300K", percent: null }
        ]);
        for (const row of page.rows) expect(row.value.length).toBeLessThanOrEqual(14);
        expect(entry.formatIdle({ cpu: null, memory: null, disk: null, network: null }, "en-US", new Date()).rows).toEqual([{ label: "CPU", value: "-", percent: null }]);
    });

    it("shows the idle page after the wait with no touch, and drops it on the first touch", async () => {
        let clock = 0;
        let tick: () => void = () => {};
        const setIdle = vi.fn();
        const reads: { report?: Uint8Array; }[] = [{ report: Uint8Array.of(0, 0) }];
        let waiting: ((read: { report: Uint8Array; }) => void) | null = null;
        const native = {
            Reader: class {
                next() {
                    const read = reads.shift();
                    return read ? Promise.resolve(read) : new Promise((done) => (waiting = done));
                }
                close() {}
            },
            Controller: class {
                feed = () => [];
                setSettings() {}
                reset() {}
                setLocale() {}
                setCall() {}
                setNowPlaying() {}
                setGames() {}
                setIdle = setIdle;
            },
            nowPlaying: async () => "null",
            settingsFromPlugin: (values: string) => values,
            ownershipJson: () => "{}"
        };
        let listener: (event: { data: unknown; }) => void = () => {};
        const stats = { read: () => ({ cpu: 5, memory: null, disk: null, network: null }), reset: vi.fn() };
        entry.run({
            port: { postMessage: () => {}, on: (_: string, next: typeof listener) => (listener = next) },
            native,
            now: () => clock,
            every: (next: () => void) => ((tick = next), 1),
            stopEvery: () => {},
            exit: () => {},
            stats,
            clock: () => new Date(2026, 0, 1, 12, 0)
        });
        listener({ data: { type: "start", settings: { idleAfter: 30, display: "mixer" }, locale: "en-US" } });
        await new Promise((done) => setTimeout(done, 0));
        clock = 29_000;
        tick();
        expect(setIdle).not.toHaveBeenCalled();
        clock = 30_000;
        tick();
        const shown = JSON.parse(setIdle.mock.calls[0]![0] as string) as { clock: string; rows: unknown[] };
        expect(shown.clock).toMatch(/^12:00/);
        expect(shown.rows).toEqual([{ label: "CPU", value: "5%", percent: 5 }]);
        expect(stats.reset).toHaveBeenCalledTimes(1);
        clock = 31_000;
        waiting!({ report: Uint8Array.of(0, 1) });
        await new Promise((done) => setTimeout(done, 0));
        expect(setIdle).toHaveBeenLastCalledWith("null");
        tick();
        expect(setIdle).toHaveBeenCalledTimes(2);
    });
});
