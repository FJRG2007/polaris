import { describe, expect, it, vi } from "vitest";
import { addressedServer, serverFromSlug, serverSlug } from "@/lib/watch/server-route";

vi.mock("@polaris/ssh", () => ({ execCommand: vi.fn(), openSshClient: vi.fn() }));
vi.mock("@/lib/host-service", () => ({ getHostConnectionUnscoped: vi.fn() }));

const { parseProcesses } = await import("@/lib/watch/machine-processes");

const CONTAINER = `0::/system.slice/docker-${"a".repeat(64)}.scope`;

describe("parseProcesses", () => {
    it("adds up every copy of a program, heaviest first", () => {
        const output = [
            "100 0::/user.slice sshd",
            "1000 0::/system.slice/containerd.service containerd",
            "300 0::/user.slice sshd"
        ].join("\n");
        expect(parseProcesses(output)).toEqual([
            { name: "containerd", bytes: 1000 * 1024 },
            { name: "sshd", bytes: 400 * 1024 }
        ]);
    });

    it("leaves out what is inside a container, not the engine itself", () => {
        const output = `900 ${CONTAINER} node\n500 0::/system.slice/docker.service dockerd\n`;
        expect(parseProcesses(output).map(({ name }) => name)).toEqual(["dockerd"]);
    });

    it("keeps a name with spaces and skips what is not a row", () => {
        const output = "garbage\n10 - kworker/0:1 events\n0 - idle\n";
        expect(parseProcesses(output)).toEqual([{ name: "kworker/0:1 events", bytes: 10240 }]);
    });

    it("lists a bounded number", () => {
        const output = Array.from({ length: 30 }, (_, i) => `${i + 1} - p${i}`).join("\n");
        expect(parseProcesses(output)).toHaveLength(8);
    });
});

describe("a server's address", () => {
    const servers = [
        { id: "1", name: "lirio-0" },
        { id: "2", name: "My box" },
        { id: "3", name: "twin" },
        { id: "4", name: "TWIN" },
        { id: "5", name: "local" }
    ];

    it("reads as its name", () => {
        expect(serverSlug(servers, servers[0]!, "local")).toBe("lirio-0");
    });

    it("falls back to the id when the name cannot stand in", () => {
        expect(serverSlug(servers, servers[1]!, "local")).toBe("2");
        expect(serverSlug(servers, servers[2]!, "local")).toBe("3");
        expect(serverSlug(servers, servers[4]!, "local")).toBe("5");
    });

    it("finds a server by either", () => {
        expect(serverFromSlug(servers, "LIRIO-0")?.id).toBe("1");
        expect(serverFromSlug(servers, "2")?.id).toBe("2");
        expect(serverFromSlug(servers, "nobody")).toBeNull();
    });

    describe("the machine Polaris runs on", () => {
        const remote = [{ id: "r1", name: "edge" }];
        const unenrolled = { id: "local", name: "lirio-0" };
        const enrolled = { id: "h1", name: "lirio-0" };
        const second = { id: "h2", name: "lirio-copy" };

        it("reads as its name with no row of its own", () => {
            expect(addressedServer("local", "local", unenrolled, [], remote)).toEqual({
                host: null,
                address: "lirio-0"
            });
            expect(addressedServer("lirio-0", "local", unenrolled, [], remote)).toEqual({
                host: null,
                address: "lirio-0"
            });
        });

        it("keeps the reserved word when its name cannot stand in", () => {
            const named = { id: "local", name: "My box" };
            expect(addressedServer("local", "local", named, [], remote)?.address).toBe("local");
            const clash = { id: "local", name: "edge" };
            expect(addressedServer("local", "local", clash, [], remote)?.address).toBe("local");
        });

        it("sends a second row of the same box to the machine", () => {
            for (const slug of ["h2", "lirio-copy", "h1"]) {
                expect(addressedServer(slug, "local", enrolled, [enrolled, second], remote)).toEqual({
                    host: null,
                    address: "lirio-0"
                });
            }
        });

        it("is never a remote server called by the reserved word", () => {
            const taken = [{ id: "r2", name: "local" }];
            expect(addressedServer("local", "local", unenrolled, [], taken)?.host).toBeNull();
            expect(addressedServer("r2", "local", unenrolled, [], taken)).toEqual({
                host: taken[0],
                address: "r2"
            });
        });

        it("answers a remote server by id, reading as its name, and nothing else", () => {
            expect(addressedServer("r1", "local", unenrolled, [], remote)).toEqual({
                host: remote[0],
                address: "edge"
            });
            expect(addressedServer("nobody", "local", unenrolled, [], remote)).toBeNull();
        });

        it("settles on an address that resolves to itself", () => {
            for (const [machine, here] of [
                [unenrolled, []],
                [{ id: "local", name: "My box" }, []],
                [enrolled, [enrolled]],
                [{ id: "h1", name: "My box" }, [{ id: "h1", name: "My box" }]]
            ] as const) {
                const first = addressedServer("local", "local", machine, here, remote)!;
                expect(addressedServer(first.address, "local", machine, here, remote)?.address).toBe(
                    first.address
                );
            }
        });
    });
});
