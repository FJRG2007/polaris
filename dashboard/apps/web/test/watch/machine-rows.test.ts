import { describe, expect, it, vi } from "vitest";
import { serverFromSlug, serverSlug } from "@/lib/watch/server-route";

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
});
