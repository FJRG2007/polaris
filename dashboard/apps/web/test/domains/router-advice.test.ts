/**
 * What Polaris tells the operator is still missing outside itself.
 *
 * Two ways of being wrong matter here and they are opposites. Claiming a router is
 * broken when the probe simply could not loop back sends someone to rewrite a
 * working configuration - the probe leaves this box, so silence proves nothing on
 * its own. Staying quiet when something else is plainly answering leaves the setup
 * looking finished while the site serves a stranger's error page, which is the
 * failure that is invisible from inside the dashboard.
 *
 * The advice is also keyed on where the box lives, because the action differs: a
 * forward on a home line, a firewall rule in a datacenter, and on a carrier-NAT line
 * no forward exists to make.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const upsert = vi.fn();
const create = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findMany },
        notification: { create },
        setting: { findUnique, upsert, deleteMany: vi.fn() }
    }
}));

const { probeEdge, reportRouterAdvice, routerAdvice } = await import("../../src/lib/network-advice");

/** The probe result for a hostname nothing answered on. */
const SILENT = { answer: "silent", server: null, status: null } as const;
/** Somebody answered, and named itself the way router firmware does. */
const ROUTER = { answer: "other", server: "ZTE web server 1.0", status: 400 } as const;
const POLARIS = { answer: "polaris", server: null, status: 200 } as const;

describe("when Polaris itself answers", () => {
    it("has nothing left to ask for", () => {
        const advice = routerAdvice("home-nat", "polaris.example.com", POLARIS);

        expect(advice.ok).toBe(true);
        expect(advice.steps).toEqual([]);
    });
});

describe("when something else answers", () => {
    it("says so outright, since this one cannot be a measurement artifact", () => {
        const advice = routerAdvice("home-nat", "polaris.example.com", ROUTER);

        expect(advice.ok).toBe(false);
        expect(advice.level).toBe("danger");
        // The operator recognizes their own box by this faster than by any description.
        expect(advice.detail).toContain("ZTE web server 1.0");
    });

    it("names the status the operator is looking at, so the two are the same thing", () => {
        expect(routerAdvice("home-nat", "polaris.example.com", ROUTER).detail).toContain("400");
    });

    it("asks for the forward first, and for remote management only if it persists", () => {
        // From inside the network, a router publishing its admin page to the internet
        // and a router merely bouncing the request back look identical - and the
        // second is far the commoner. Leading with remote management sends the
        // operator to disable a setting that was never the problem.
        const advice = routerAdvice("home-nat", "polaris.example.com", ROUTER);

        expect(advice.steps[0]).toMatch(/Forward ports 80 and 443/);
        expect(advice.steps.join(" ")).toMatch(/remote \(WAN\) management/);
    });

    it("does not ask a carrier-NAT line for a forward it cannot make", () => {
        // The router answers there too, but no rule in it can bring the request any
        // further - so the walkthrough must not be offered, forward flag included.
        const advice = routerAdvice("home-cgnat", "polaris.example.com", ROUTER);

        expect(advice.forward).toBe(false);
        expect(advice.steps.join(" ")).not.toMatch(/Forward ports/);
        expect(advice.steps[0]).toMatch(/tunnel/);
        expect(advice.detail).toContain("ZTE web server 1.0");
    });

    it("does not blame a router on a box that has none", () => {
        const advice = routerAdvice("vps", "polaris.example.com", ROUTER);

        expect(advice.ok).toBe(false);
        expect(advice.steps.join(" ")).not.toMatch(/router/i);
        expect(advice.steps[0]).toMatch(/holding ports 80 and 443/);
    });
});

describe("when nothing answers", () => {
    it("asks for the forward on a home line, without claiming it is missing", () => {
        const advice = routerAdvice("home-nat", "polaris.example.com", SILENT);

        expect(advice.level).toBe("warning");
        // Silence is not proof: plenty of routers refuse to loop back to their own
        // public address, and a working domain would look dead from in here.
        expect(advice.detail).toMatch(/not proof/);
        expect(advice.steps.join(" ")).toMatch(/Forward ports 80 and 443/);
    });

    it("asks for a firewall rule in a datacenter, not a forward", () => {
        const advice = routerAdvice("cloud", "polaris.example.com", SILENT);

        expect(advice.steps[0]).toMatch(/firewall or security group/);
        expect(advice.steps.join(" ")).not.toMatch(/router/i);
    });

    it("does not ask for a forward that cannot exist behind carrier-grade NAT", () => {
        const advice = routerAdvice("home-cgnat", "polaris.example.com", SILENT);

        expect(advice.level).toBe("danger");
        expect(advice.steps.join(" ")).not.toMatch(/Forward ports/);
        expect(advice.steps[0]).toMatch(/tunnel/);
    });
});

describe("every advice", () => {
    it("says port 80 is needed wherever it asks for ports to be opened", () => {
        // An HTTPS-only reading of the advice leaves :80 shut, and then the
        // certificate never issues - the site is unreachable for a different reason.
        for (const environment of ["home-nat", "cloud", "unknown"] as const) {
            expect(routerAdvice(environment, "a.example.com", SILENT).steps.join(" ")).toMatch(/Port 80 is needed/);
        }
    });

    it("names the hostname it is talking about", () => {
        for (const probe of [SILENT, ROUTER]) {
            expect(routerAdvice("home-nat", "polaris.example.com", probe).detail).toContain("polaris.example.com");
        }
    });

    it("carries what the panel needs to walk the operator through their router", () => {
        const advice = routerAdvice("home-nat", "polaris.example.com", ROUTER, "192.168.1.20");

        expect(advice.forward).toBe(true);
        expect(advice.server).toBe("ZTE web server 1.0");
        expect(advice.lanIp).toBe("192.168.1.20");
    });

    it("offers no port forward where no forward can help", () => {
        // A firewall rule on a VPS and a carrier-NAT line are not router problems;
        // walking someone through a port forward there is a wasted afternoon.
        expect(routerAdvice("vps", "a.example.com", SILENT).forward).toBe(false);
        expect(routerAdvice("home-cgnat", "a.example.com", SILENT).forward).toBe(false);
        expect(routerAdvice("home-nat", "a.example.com", POLARIS).forward).toBe(false);
    });
});

describe("probing who answers", () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it("takes only Polaris's own marker as Polaris", async () => {
        vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

        expect(await probeEdge("a.example.com")).toMatchObject({ answer: "polaris" });
    });

    it("treats any other reply as something in the way, and keeps its name", async () => {
        vi.stubGlobal(
            "fetch",
            async () => new Response("<h2>400 Bad Request</h2>", { status: 400, headers: { server: "ZTE web server 1.0" } })
        );

        expect(await probeEdge("a.example.com")).toEqual({
            answer: "other",
            server: "ZTE web server 1.0",
            status: 400
        });
    });

    it("does not mistake a 200 from somebody else for Polaris", async () => {
        // A router login page answers 200 as readily as an error does.
        vi.stubGlobal("fetch", async () => new Response("<html>Router</html>", { status: 200 }));

        expect(await probeEdge("a.example.com")).toMatchObject({ answer: "other" });
    });

    it("reports a refused connection as silence, not as an intruder", async () => {
        vi.stubGlobal("fetch", async () => {
            throw new Error("ECONNREFUSED");
        });

        expect(await probeEdge("a.example.com")).toEqual({ answer: "silent", server: null, status: null });
    });
});

describe("telling the administrators", () => {
    const settings = new Map<string, string>();

    beforeEach(() => {
        settings.clear();
        create.mockReset();
        findMany.mockReset();
        findMany.mockResolvedValue([{ id: "admin-1" }, { id: "admin-2" }]);
        findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
            const value = settings.get(where.key);
            return value === undefined ? null : { value };
        });
        upsert.mockImplementation(async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
            settings.set(where.key, update.value);
            return { key: where.key, value: update.value };
        });
        vi.stubGlobal("fetch", async () => {
            throw new Error("ECONNREFUSED");
        });
    });

    it("notifies every administrator, since this is the deployment's problem", async () => {
        await reportRouterAdvice("home-nat", "polaris.example.com");

        expect(create).toHaveBeenCalledTimes(2);
        expect(create.mock.calls.map((call) => call[0].data.userId).sort()).toEqual(["admin-1", "admin-2"]);
        expect(create.mock.calls[0][0].data.href).toBe("/admin/domains");
    });

    it("stays quiet while the same thing goes on being true", async () => {
        await reportRouterAdvice("home-nat", "polaris.example.com");
        create.mockReset();

        await reportRouterAdvice("home-nat", "polaris.example.com");

        // A setup left broken for a week must not fill the bell with one notice.
        expect(create).not.toHaveBeenCalled();
    });

    it("speaks again when the diagnosis changes", async () => {
        await reportRouterAdvice("home-nat", "polaris.example.com");
        create.mockReset();
        vi.stubGlobal("fetch", async () => new Response("nope", { status: 400, headers: { server: "ZTE" } }));

        await reportRouterAdvice("home-nat", "polaris.example.com");

        expect(create).toHaveBeenCalledTimes(2);
        expect(create.mock.calls[0][0].data.level).toBe("danger");
    });

    it("says so when it starts working, so a fix is confirmed", async () => {
        await reportRouterAdvice("home-nat", "polaris.example.com");
        create.mockReset();
        vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

        await reportRouterAdvice("home-nat", "polaris.example.com");

        expect(create).toHaveBeenCalledTimes(2);
        expect(create.mock.calls[0][0].data.level).toBe("success");
    });

    it("announces nothing on a first check that finds no problem", async () => {
        vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

        await reportRouterAdvice("home-nat", "polaris.example.com");

        // There was no problem to report solved.
        expect(create).not.toHaveBeenCalled();
    });
});
