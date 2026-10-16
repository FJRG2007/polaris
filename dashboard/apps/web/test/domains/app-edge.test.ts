/**
 * An app's own edge file: written only through `writeDynamicFile`, emptied when
 * the app is uninstalled, and a hostname another router answers is taken.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const writeDynamicFile = vi.hoisted(() => vi.fn());
const dashboardHosts = vi.hoisted(() => vi.fn());
const findUnique = vi.hoisted(() => vi.fn());

vi.mock("@/lib/traefik-dynamic", () => ({ writeDynamicFile }));
vi.mock("@/lib/domain-edge", () => ({ dashboardHosts, dashboardOrigin: () => "http://web:3000" }));
const findTunnel = vi.hoisted(() => vi.fn());
vi.mock("@polaris/db", () => ({
    prisma: { domain: { findUnique }, wireguardTunnel: { findUnique: findTunnel } }
}));

import {
    appEdgeFile,
    clearAppEdge,
    edgeHostnameTaken,
    writeAppEdge,
    EMPTY_EDGE
} from "@/lib/app-edge";

beforeEach(() => {
    vi.clearAllMocks();
    writeDynamicFile.mockResolvedValue(undefined);
    dashboardHosts.mockResolvedValue(["polaris.example.com"]);
    findUnique.mockResolvedValue(null);
    findTunnel.mockResolvedValue(null);
});

describe("app edge", () => {
    it("names one file per app and refuses anything that is not an app id", () => {
        expect(appEdgeFile("status-pages")).toBe("polaris-app-status-pages.yml");
        expect(() => appEdgeFile("../apps")).toThrow();
    });

    it("writes through writeDynamicFile", async () => {
        await writeAppEdge("status-pages", "http: {}\n");
        expect(writeDynamicFile).toHaveBeenCalledWith("polaris-app-status-pages.yml", "http: {}\n");
    });

    it("empties the file on uninstall and never throws", async () => {
        writeDynamicFile.mockRejectedValueOnce(new Error("read-only"));
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(clearAppEdge("status-pages")).resolves.toBeUndefined();
        expect(writeDynamicFile).toHaveBeenCalledWith("polaris-app-status-pages.yml", EMPTY_EDGE);
        log.mockRestore();
    });

    it("counts the dashboard's hostnames and deployed domains as taken", async () => {
        expect(await edgeHostnameTaken("Polaris.Example.com")).toBe(true);
        findUnique.mockResolvedValueOnce({ id: "d1" });
        expect(await edgeHostnameTaken("app.example.com")).toBe(true);
        expect(await edgeHostnameTaken("status.example.com")).toBe(false);
    });

    it("counts a WireGuard tunnel's hostname as taken", async () => {
        findTunnel.mockResolvedValueOnce({ id: "t1" });
        expect(await edgeHostnameTaken("home.example.com")).toBe(true);
        expect(findTunnel).toHaveBeenCalledWith({
            where: { hostname: "home.example.com" },
            select: { id: true }
        });
    });
});
