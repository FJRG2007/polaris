/** Router: a Linux machine running the network, with two lines and three networks. */

import { PageHeader } from "@polaris/ui";
import { id } from "../fixtures/people";
import { Chrome } from "../runtime/chrome";
import type { RouterPlan } from "@/lib/router/plan";
import type { RouterReading } from "@/lib/router/read";
import { defineScene, type SceneContext } from "../runtime/scene";
import { RouterSection } from "@/app/(app)/apps/router/router-view";
import { useTranslations } from "@/components/i18n/i18n-provider";

const MACHINE = id("router-machine", 1);

/** Fifty minutes of a lease left, in the seconds a lease counts in. */
const leaseEnd = (ctx: SceneContext) => Math.floor(ctx.now / 1000) + 3_000;

function plan(ctx: SceneContext): RouterPlan {
    const lan = (
        n: number,
        name: string,
        vlan: number | null,
        cidr: string,
        address: string,
        more: Partial<RouterPlan["lans"][number]> = {}
    ) => ({
        id: id("router-lan", n),
        name,
        interface: "eth2",
        vlan,
        cidr,
        address,
        internet: true,
        isolated: false,
        reservations: [],
        ...more
    });
    return {
        wans: [
            { interface: "eth0", vlan: null },
            { interface: "eth1", vlan: 20 }
        ],
        lans: [
            lan(1, ctx.say("Office", "Oficina"), null, "10.20.0.0/24", "10.20.0.1"),
            lan(2, ctx.say("Guests", "Invitados"), 30, "10.30.0.0/24", "10.30.0.1", {
                isolated: true
            }),
            lan(3, ctx.say("Cameras", "Cámaras"), 40, "10.40.0.0/24", "10.40.0.1", {
                internet: false
            })
        ],
        forwards: [
            { protocol: "tcp", port: 443, address: "10.20.0.20", toPort: 443 },
            { protocol: "udp", port: 51820, address: "10.20.0.21", toPort: 51820 }
        ]
    };
}

function reading(ctx: SceneContext): RouterReading {
    const port = (
        n: number,
        name: string,
        up: boolean,
        addresses: string[],
        hasGateway = false
    ) => ({
        name,
        up,
        mac: `02:00:00:00:00:0${n}`,
        addresses,
        hasGateway,
        received: 0,
        sent: 0
    });
    const client = (address: string, n: number, name: string | null) => ({
        address,
        mac: `02:00:00:00:01:0${n}`,
        name,
        expires: leaseEnd(ctx)
    });
    return {
        ports: [
            port(1, "eth0", true, ["203.0.113.10/24"], true),
            port(2, "eth1", true, []),
            port(3, "eth1.20", true, ["198.51.100.20/24"], true),
            port(4, "eth2", true, ["10.20.0.1/24"]),
            port(5, "eth2.30", true, ["10.30.0.1/24"]),
            port(6, "eth2.40", true, ["10.40.0.1/24"]),
            port(7, "eth3", false, [])
        ],
        activeWan: "eth0",
        running: true,
        clients: [
            client("10.20.0.20", 1, "nas"),
            client("10.20.0.34", 2, "alex-laptop"),
            client("10.20.0.47", 3, "ana-phone"),
            client("10.30.0.12", 4, ctx.say("visitor-tablet", "tablet-visitas")),
            client("10.40.0.8", 5, null)
        ],
        rolledBack: false
    };
}

/** The page `/apps/router` draws, inside the frame its layout gives it. */
function Router() {
    const t = useTranslations("router");
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col">
            <PageHeader title={t("title")} description={t("description")} />
            <RouterSection />
        </div>
    );
}

export const router = defineScene({
    id: "router",
    path: "/apps/router",
    actions: (ctx) => ({
        listMachinesAction: () => ({
            machines: [{ id: MACHINE, name: "gateway-01", address: "10.20.0.1", root: true }],
            privateNetworks: []
        }),
        readRouterAction: () => ({ plan: plan(ctx), reading: reading(ctx) })
    }),
    render: () => (
        <Chrome>
            <Router />
        </Chrome>
    )
});
