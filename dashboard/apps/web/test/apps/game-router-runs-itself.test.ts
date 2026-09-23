/**
 * Polaris starts the router, rather than telling somebody to go and edit a file.
 *
 * Sharing one port between every Java server used to refuse with "add mcrouter to
 * COMPOSE_PROFILES and restart Polaris" - a terminal, a file and an install to
 * edit, for a button that had just been pressed. Nothing in this product may ask
 * for that, so the dashboard runs the router itself, as its own one-service
 * project through the daemon.
 *
 * The two names it needs are read off the dashboard's own container rather than
 * assumed, because both carry the compose project this Polaris was installed as:
 * checked on the live stack on 2026-09-23, they were `polaris_default` and
 * `polaris_polaris-mc-routes`, and a router joined to that network reached
 * `http://web:3000/api/health`. The same probe showed what happens when the table
 * is missing: mc-router watches that file and exits at startup if it is not there,
 * which is why the table is written before the router is started.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { docker, composed } = vi.hoisted(() => ({
    docker: { answer: "" as string, status: 200 },
    composed: [] as unknown[]
}));

vi.mock("@polaris/hostd-client", () => ({
    HostdClient: class {
        public async dockerRequest(_method: string, _path: string) {
            return { status: docker.status, body: docker.answer };
        }
    }
}));

vi.mock("@/lib/deploy/ports-hostd", () => ({
    HostdPorts: class {
        public async composeUp(spec: unknown) {
            composed.push(spec);
        }
        public async composeDown() {}
    }
}));

const { ROUTER_IMAGE, ROUTER_PROJECT, routerPlacement, routerSpec, startRouter } = await import(
    "@/lib/minecraft-router"
);

/** What the daemon says about the dashboard's own container. */
const SELF = JSON.stringify({
    NetworkSettings: { Networks: { polaris_default: {} } },
    Mounts: [
        { Type: "volume", Name: "polaris_polaris-data", Destination: "/var/lib/polaris" },
        { Type: "volume", Name: "polaris_polaris-mc-routes", Destination: "/mc-routes" }
    ]
});

beforeEach(() => {
    docker.answer = SELF;
    docker.status = 200;
    composed.length = 0;
});

describe("where the router has to be", () => {
    it("is read off the dashboard's own container", async () => {
        expect(await routerPlacement()).toEqual({
            network: "polaris_default",
            routesVolume: "polaris_polaris-mc-routes"
        });
    });

    it("is the control plane's network, not whichever came back first", async () => {
        // The dashboard is also on the network a locally installed messaging bridge
        // joins, and the order is not ours to rely on. A router on the wrong one
        // reaches nothing.
        docker.answer = JSON.stringify({
            NetworkSettings: { Networks: { "polaris-hub": {}, polaris_default: {} } },
            Mounts: [{ Type: "volume", Name: "polaris_polaris-mc-routes", Destination: "/mc-routes" }]
        });
        expect((await routerPlacement())?.network).toBe("polaris_default");
    });

    it("is nothing at all when the daemon cannot say", async () => {
        // The limited edition, where there is no daemon. Nothing to start, and the
        // caller says so in a sentence rather than deploying into a guess.
        docker.status = 404;
        expect(await routerPlacement()).toBeNull();
    });

    it("is nothing when this container holds no routing table", async () => {
        docker.answer = JSON.stringify({
            NetworkSettings: { Networks: { polaris_default: {} } },
            Mounts: []
        });
        expect(await routerPlacement()).toBeNull();
    });
});

describe("the project Polaris deploys", () => {
    const spec = () =>
        routerSpec({ network: "polaris_default", routesVolume: "polaris_polaris-mc-routes" }, 25565);

    it("is one service on the port players connect to", () => {
        expect(spec().project).toBe(ROUTER_PROJECT);
        expect(spec().services[0]?.image).toBe(ROUTER_IMAGE);
        expect(spec().services[0]?.ports).toEqual([{ host: 25565, container: 25565, protocol: "tcp" }]);
    });

    it("mounts the dashboard's table and never owns it", () => {
        // Declared external: this project must not create, rename or remove the
        // volume the dashboard writes its routes to.
        expect(spec().services[0]?.volumes).toEqual([
            { source: "polaris_polaris-mc-routes", target: "/mc-routes", kind: "volume" }
        ]);
        expect(spec().externalVolumes).toEqual(["polaris_polaris-mc-routes"]);
        expect(spec().volumes).toEqual([]);
    });

    it("joins the network the dashboard answers on, which is how a knock reaches it", () => {
        expect(spec().networks).toEqual(["polaris_default"]);
        expect(spec().services[0]?.env.AUTO_SCALE_WEBHOOK_URL).toBe(
            "http://web:3000/api/minecraft/wake"
        );
        expect(spec().services[0]?.env.AUTO_SCALE_UP).toBe("true");
    });

    it("watches the table and says what an asleep server looks like", () => {
        expect(spec().services[0]?.env.ROUTES_CONFIG).toBe("/mc-routes/mc-routes.json");
        expect(spec().services[0]?.env.ROUTES_CONFIG_WATCH).toBe("true");
        expect(spec().services[0]?.env.AUTO_SCALE_ASLEEP_MOTD).toContain("join");
    });

    it("comes back with the machine", () => {
        expect(spec().services[0]?.restart).toBe("unless-stopped");
    });
});

describe("starting it", () => {
    it("deploys the project", async () => {
        expect(await startRouter(25565)).toBeNull();
        expect(composed).toHaveLength(1);
    });

    it("says what is wrong instead of a command to run", async () => {
        docker.status = 500;
        const failure = await startRouter(25565);
        expect(failure).toBeTruthy();
        expect(failure).not.toMatch(/COMPOSE_PROFILES|docker |\.env/);
        expect(composed).toEqual([]);
    });
});
