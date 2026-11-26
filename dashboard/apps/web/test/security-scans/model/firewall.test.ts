import { describe, expect, it } from "vitest";
import * as specs from "@polaris-app/security-scans/src/model/specs";
import * as schemas from "@polaris-app/security-scans/src/model/schemas";
import * as firewall from "@polaris-app/security-scans/src/model/firewall";

/** The Polaris machine as its status read printed it (shape of lirio-0, 11-25). */
const LOCAL = [
    "POLARIS_DISTRO id=ubuntu",
    "POLARIS_NFT=yes",
    "POLARIS_FIREWALL=off",
    "POLARIS_ADDR=lo 127.0.0.1",
    "POLARIS_ADDR=enp3s0 192.168.1.142",
    "POLARIS_ADDR=virbr0 192.168.122.1",
    "POLARIS_ADDR=docker0 172.17.0.1",
    "POLARIS_BOUND=polaris-traefik-1 80/tcp=80 443/tcp=443",
    "POLARIS_BOUND=game-a 25565/tcp=25566",
    "POLARIS_BOUND=sleeping-game 25565/tcp=25569",
    "POLARIS_BOUND=polaris-vpn-control-1 29564/tcp=29564",
    "POLARIS_BOUND=picks-its-own 8080/tcp=",
    "POLARIS_LISTEN=tcp 22 0.0.0.0 sshd -",
    "POLARIS_LISTEN=tcp 80 0.0.0.0 docker-proxy -",
    "POLARIS_LISTEN=tcp 25566 0.0.0.0 docker-proxy -",
    "POLARIS_LISTEN=tcp 5201 * iperf3 -",
    "POLARIS_LISTEN=tcp 9090 * cockpit.socket -",
    "POLARIS_LISTEN=tcp 7880 * livekit-server polaris-livekit-1",
    "POLARIS_LISTEN=tcp 7881 * livekit-server polaris-livekit-1",
    "POLARIS_LISTEN=udp 7882 192.168.1.142 livekit-server polaris-livekit-1",
    "POLARIS_LISTEN=tcp 35391 0.0.0.0 vision-worker polaris-vision-worker-1",
    "POLARIS_LISTEN=udp 5353 0.0.0.0 avahi polaris-mdns-1",
    "POLARIS_LISTEN=udp 53 192.168.122.1 dnsmasq -",
    "POLARIS_LISTEN=udp 67 0.0.0.0%virbr0 dnsmasq -",
    "POLARIS_LISTEN=tcp 53 127.0.0.53%lo systemd-resolve -",
    "POLARIS_LISTEN=tcp 631 [::1] cupsd -"
].join("\n");

function plan(output: string, keep: readonly string[] = [], local = true, sshPort: number | null = null) {
    const report = firewall.parseFirewallLog(output);
    if (!report) throw new Error("status read did not parse");
    return { report, plan: firewall.planFirewall(report, { local, sshPort, keep }) };
}

describe("host firewall status read", () => {
    it("reads state, published ports and listeners", () => {
        const { report } = plan(LOCAL);
        expect(report.state).toBe("off");
        expect(report.nft).toBe(true);
        expect(report.router).toBe(false);
        expect(report.bound.find(({ container }) => container === "game-a")?.words).toEqual(["tcp:25566"]);
        // A port the engine picks has no host port to open.
        expect(report.bound.some(({ container }) => container === "picks-its-own")).toBe(false);
        expect(report.listeners.find(({ word }) => word === "tcp:7880")?.container).toBe("polaris-livekit-1");
    });

    it("is not a report when the output is not one", () => {
        expect(firewall.parseFirewallLog("")).toBeNull();
        expect(firewall.parseFirewallLog("POLARIS_FIREWALL=maybe")).toBeNull();
    });
});

describe("host firewall plan", () => {
    it("lists the operator's own services as closing and keeps Polaris's open", () => {
        const { plan: result } = plan(LOCAL);
        expect(result.closing).toEqual([
            { word: "tcp:5201", process: "iperf3" },
            { word: "tcp:9090", process: "cockpit.socket" }
        ]);
        const reasons = Object.fromEntries(result.open.map(({ word, reason }) => [word, reason]));
        expect(reasons).toMatchObject({
            "tcp:22": "ssh",
            "tcp:80": "web",
            "tcp:443": "web",
            "udp:443": "web",
            "tcp:7880": "calls",
            "tcp:7881": "calls",
            "udp:7882": "calls",
            "udp:5353": "discovery",
            "tcp:25566": "container",
            "tcp:25569": "container",
            "tcp:29564": "container",
            "tcp:35391": "container"
        });
        // Virtual-machine networks and loopback are never filtered, so nothing there closes or opens.
        for (const word of ["udp:53", "udp:67", "tcp:53", "tcp:631"]) {
            expect(result.closing.some((port) => port.word === word)).toBe(false);
            expect(result.open.some((port) => port.word === word)).toBe(false);
        }
        expect(result.blocked).toBeNull();
        expect(result.opens).toBe(true);
    });

    it("closes a port by default and keeps one open only when a person kept it", () => {
        const { plan: result } = plan(LOCAL, ["tcp:9090"]);
        expect(result.closing).toEqual([{ word: "tcp:5201", process: "iperf3" }]);
        expect(result.open.find(({ word }) => word === "tcp:9090")).toEqual({
            word: "tcp:9090",
            reason: "kept",
            detail: "cockpit.socket"
        });
    });

    it("keeps the port Polaris logs in on, and calls stay off a remote server", () => {
        const { plan: result } = plan(LOCAL, [], false, 2222);
        expect(result.open[0]).toEqual({ word: "tcp:2222", reason: "ssh", detail: null });
        expect(result.open.some(({ reason }) => reason === "calls")).toBe(false);
        // LiveKit there runs in a container on the host network, so it is still an app's port.
        expect(result.open.find(({ word }) => word === "tcp:7880")?.reason).toBe("container");
    });

    it("refuses where the Router app's firewall is, and names a firewall it replaces", () => {
        const router = plan(`${LOCAL}\nPOLARIS_ROUTER=yes`).plan;
        expect(router.blocked).toBe("router");
        const ufw = plan(`${LOCAL}\nPOLARIS_OTHER=ufw`).plan;
        expect(ufw.replaces).toBe("ufw");
    });

    it("opens nothing new on a firewall that already allows everything planned", () => {
        const first = plan(LOCAL, ["tcp:5201", "tcp:9090"]).plan;
        const on = [
            LOCAL.replace("POLARIS_FIREWALL=off", "POLARIS_FIREWALL=on"),
            ...first.open.map(({ word }) => `POLARIS_ALLOWED=${word}`)
        ].join("\n");
        expect(plan(on, ["tcp:5201", "tcp:9090"]).plan.opens).toBe(false);
        expect(plan(`${on}\nPOLARIS_BOUND=new-app 3000/tcp=3000`, ["tcp:5201", "tcp:9090"]).plan.opens).toBe(true);
    });
});

describe("host firewall pass", () => {
    const off = plan(LOCAL).plan;
    const nothingCloses = plan(LOCAL, ["tcp:5201", "tcp:9090"]).plan;

    const closesNothing = { ...nothingCloses, closing: [], replaces: null };
    const closesOne = { ...nothingCloses, closing: [{ word: "tcp:5201", process: "iperf3" }], replaces: null };

    it("turns a firewall on by itself only where nothing in use would close", () => {
        expect(firewall.firewallStep(null, { state: "off", plan: closesNothing })).toBe("enable");
        // Something listening would close, or another firewall would be replaced: a person decides.
        expect(firewall.firewallStep(null, { state: "off", plan: closesOne })).toBe("review");
        expect(firewall.firewallStep(null, { state: "off", plan: { ...closesNothing, replaces: "ufw" } })).toBe(
            "review"
        );
        // Told once; a later pass neither repeats it nor switches anything on.
        for (const plan of [closesNothing, closesOne]) {
            expect(firewall.firewallStep({ firewallChoice: null, firewallNotifiedAt: new Date() }, { state: "off", plan })).toBeNull();
        }
    });

    it("keeps a firewall Polaris turned on in step with what is deployed", () => {
        const opens = { ...closesNothing, opens: true };
        expect(firewall.firewallStep({ firewallChoice: "auto", firewallNotifiedAt: new Date() }, { state: "on", plan: opens })).toBe(
            "sync"
        );
        // Turned off outside Polaris afterwards: not switched back on.
        expect(firewall.firewallStep({ firewallChoice: "auto", firewallNotifiedAt: new Date() }, { state: "off", plan: closesNothing })).toBeNull();
    });

    it("leaves a firewall a person turned off alone", () => {
        expect(
            firewall.firewallStep({ firewallChoice: "off", firewallNotifiedAt: null }, { state: "off", plan: off })
        ).toBeNull();
    });

    it("re-applies only a firewall a person turned on, and only to open something new", () => {
        const opens = { ...off, opens: true };
        expect(firewall.firewallStep({ firewallChoice: "on", firewallNotifiedAt: null }, { state: "on", plan: opens })).toBe(
            "sync"
        );
        expect(
            firewall.firewallStep({ firewallChoice: "on", firewallNotifiedAt: null }, { state: "on", plan: { ...off, opens: false } })
        ).toBeNull();
        expect(firewall.firewallStep(null, { state: "on", plan: opens })).toBeNull();
        expect(firewall.firewallStep({ firewallChoice: "on", firewallNotifiedAt: null }, { state: "armed", plan: opens })).toBeNull();
    });

    it("does nothing where the Router app's firewall is", () => {
        expect(firewall.firewallStep(null, { state: "router", plan: { ...off, blocked: "router" } })).toBeNull();
    });
});

describe("host firewall answers and input", () => {
    it("reads what an apply or confirm said", () => {
        expect(firewall.parseFirewallEnding("POLARIS_DISTRO id=debian\nPOLARIS_FIREWALL=armed\n")).toBe("armed");
        expect(firewall.parseFirewallEnding("POLARIS_FIREWALL=rolled-back")).toBe("rolled-back");
        expect(firewall.parseFirewallEnding("POLARIS_FIREWALL=whatever")).toBeNull();
    });

    it("takes only port words the daemon takes", () => {
        expect(firewall.isPortWord("tcp:22")).toBe(true);
        expect(firewall.isPortWord("udp:65535")).toBe(true);
        for (const bad of ["tcp:0", "tcp:022", "tcp:65536", "icmp:1", "tcp:22 ", "tcp:22;reboot"]) {
            expect(firewall.isPortWord(bad)).toBe(false);
        }
        const id = "0b8e8a52-6b0e-4c1e-9d3a-2f6f4b1c7a10";
        expect(schemas.firewallApplyInput.safeParse({ targetId: id, keep: ["tcp:5201"] }).success).toBe(true);
        expect(schemas.firewallApplyInput.safeParse({ targetId: id, keep: ["tcp:99999"] }).success).toBe(false);
        expect(schemas.firewallApplyInput.safeParse({ targetId: id }).success).toBe(false);
    });

    it("runs the firewall scripts with the port list as positional words", () => {
        const argv = specs.hostArgv("firewall-apply", ["polaris-apply-id", "tcp:22"]);
        expect(argv.at(-1)).toBe("tcp:22");
        expect(argv).toContain(specs.UPDATES_SCRIPTS["firewall-apply"]);
    });
});
