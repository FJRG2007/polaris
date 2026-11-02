/**
 * Applying a plan: Polaris keeps a plan only once the machine confirmed this very
 * change, and says it went back only once it has.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execCommand = vi.fn();
const setSetting = vi.fn();
vi.mock("@polaris/ssh", () => ({
    execCommand,
    openSshClient: vi.fn(async () => ({ end: vi.fn() }))
}));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy/server-edge", () => ({ edgeLauncher: () => "sudo sh" }));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(async () => null), setSetting }));
vi.mock("@/lib/host-service", () => ({
    getHostConnection: vi.fn(async () => ({
        address: "192.0.2.5",
        port: 22,
        username: "root",
        auth: {},
        hostKey: "fixture",
        sudo: false
    }))
}));

const { applyRouter, RouterRefusal } = await import("@/lib/router/service");

const HOST = "0190f1c2-0000-7000-8000-00000000000a";
const PLAN = {
    wans: [{ interface: "eth0", vlan: null }],
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
};
const PROBE = [
    "---links",
    '[{"ifname":"eth0","operstate":"UP"},{"ifname":"eth1","operstate":"UP"}]',
    "---end"
].join("\n");

type Script = (input: string) => string | Error;

/** Answer every script the way a machine would: `onState` handles the confirm and
 *  rollback scripts, told apart by what only the rollback script reads. */
function machine(onState: Script): string[] {
    const sent: string[] = [];
    execCommand.mockImplementation(
        async (
            _client: unknown,
            _command: string,
            options: { input?: string; onStdout?: (chunk: Buffer) => void }
        ) => {
            const input = options.input;
            if (input === undefined) {
                options.onStdout?.(Buffer.from("192.0.2.9"));
                return { code: 0 };
            }
            sent.push(input);
            const isApply = input.includes("polaris-router-activate.timer polaris-router-activate");
            const said = input.includes('echo "---links"')
                ? PROBE
                : isApply
                  ? "accepted"
                  : onState(input);
            if (said instanceof Error) throw said;
            options.onStdout?.(Buffer.from(said));
            return { code: 0 };
        }
    );
    return sent;
}

const isRollback = (script: string) =>
    script.includes("[ ! -f /var/lib/polaris-router/unconfirmed ]");

async function settled<T>(work: Promise<T>): Promise<T> {
    const outcome = work.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(400_000);
    const result = await outcome;
    if (result instanceof Error) throw result;
    return result as T;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    execCommand.mockReset();
    setSetting.mockReset();
});

describe("applyRouter", () => {
    it("keeps the plan once this change is confirmed, whatever a later read would say", async () => {
        const sent = machine(() => "confirmed\n");
        await settled(applyRouter(HOST, "owner", PLAN));
        expect(setSetting).toHaveBeenCalledWith(`router.plan.${HOST}`, JSON.stringify(PLAN));
        const applied = sent.find((script) => script.includes("activate.sh")) ?? "";
        const confirm = sent.at(-1) ?? "";
        const id = /echo ([0-9a-f-]{36}) > /.exec(applied)?.[1];
        expect(id).toBeTruthy();
        expect(confirm).toContain(`= "${id}"`);
        expect(sent.filter((script) => script.includes('echo "---links"'))).toHaveLength(1);
    });

    it("does not keep a plan the machine went back from", async () => {
        machine(() => "rolled-back\n");
        await expect(settled(applyRouter(HOST, "owner", PLAN))).rejects.toThrow("rolledBack");
        expect(setSetting).not.toHaveBeenCalled();
    });

    it("tells a machine still waiting to go back, and answers only once it has", async () => {
        let rollbacks = 0;
        const sent = machine((script) => {
            if (!isRollback(script)) return "waiting\n";
            rollbacks += 1;
            return rollbacks < 3 ? "waiting\n" : "rolled-back\n";
        });
        const error = await settled(applyRouter(HOST, "owner", PLAN)).catch((caught) => caught);
        expect(error).toBeInstanceOf(RouterRefusal);
        expect((error as InstanceType<typeof RouterRefusal>).code).toBe("rolledBack");
        expect(rollbacks).toBe(3);
        expect(isRollback(sent.at(-1) ?? "")).toBe(true);
        expect(setSetting).not.toHaveBeenCalled();
    });

    it("keeps the plan when the confirmation arrived but its answer was lost", async () => {
        machine((script) => (isRollback(script) ? "confirmed\n" : new Error("connection lost")));
        await settled(applyRouter(HOST, "owner", PLAN));
        expect(setSetting).toHaveBeenCalledWith(`router.plan.${HOST}`, JSON.stringify(PLAN));
    });

    it("does not claim a rollback it never saw from a machine that went silent", async () => {
        machine(() => new Error("connection lost"));
        await expect(settled(applyRouter(HOST, "owner", PLAN))).rejects.toThrow("unconfirmed");
        expect(setSetting).not.toHaveBeenCalled();
    });
});
