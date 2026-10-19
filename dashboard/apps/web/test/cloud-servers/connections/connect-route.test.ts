/**
 * Cloud servers no longer connects accounts on its own screen: its Connect
 * goes to the connections hub, pointed at its section with the way back, and
 * an old link to connecting there redirects to the same place.
 */

import { describe, expect, it, vi } from "vitest";
import { connectionsHref } from "../../../src/lib/connections/hub-href";

vi.mock("@polaris-app/cloud-servers/src/lib/service", () => ({
    requireCloudUser: async () => ({ id: "user-1" })
}));
vi.mock("@polaris-app/cloud-servers/src/screens/cloud-servers-screen", () => ({
    CloudServersScreen: () => null
}));
vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error("NOT_FOUND");
    },
    redirect: (to: string) => {
        throw new Error(`REDIRECT ${to}`);
    }
}));

const routes = await import("@polaris-app/cloud-servers/src/lib/cloud-routes");
const page = (
    await import("@polaris-app/cloud-servers/src/routes/apps/servers/cloud/[[...path]]/page")
).default;

const open = (path: string[] | undefined, search: Record<string, string> = {}) =>
    page({
        params: Promise.resolve<Record<string, string[]>>(path ? { path } : {}),
        searchParams: Promise.resolve(search)
    });

describe("connecting a cloud account", () => {
    it("goes to the hub's Cloud servers section and back to the app", () => {
        expect(routes.CONNECT_HREF).toBe(connectionsHref("cloud-servers", routes.CLOUD_PAGE));
    });

    it("redirects the old Connect links there", async () => {
        await expect(open(["connect"])).rejects.toThrow(`REDIRECT ${routes.CONNECT_HREF}`);
        await expect(open(undefined, { connect: "1" })).rejects.toThrow(
            `REDIRECT ${routes.CONNECT_HREF}`
        );
    });

    it("still draws the screen, and refuses any other path", async () => {
        await expect(open(undefined)).resolves.toBeTruthy();
        await expect(open(["other"])).rejects.toThrow("NOT_FOUND");
    });
});
