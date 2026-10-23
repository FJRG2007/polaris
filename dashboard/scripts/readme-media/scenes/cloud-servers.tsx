/** Cloud servers: the machines rented through the accounts connected to Polaris. */

import { PAGE_FILL } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { ago, id } from "../fixtures/people";
import { defineScene } from "../runtime/scene";
import { CloudServersScreen } from "../../../apps/cloud-servers/src/screens/cloud-servers-screen";

const DO = id("cloud-account", 1);
const HZ = id("cloud-account", 2);

export const cloudServers = defineScene({
    id: "cloud-servers",
    path: "/apps/servers/cloud",
    actions: (ctx) => {
        const server = (
            n: number,
            accountId: string,
            provider: "digitalocean" | "hetzner",
            name: string,
            region: string,
            size: string,
            status: string,
            ipv4: string,
            monthly: number,
            days: number
        ) => ({
            id: id("cloud-server", n),
            accountId,
            provider,
            name,
            region,
            size,
            image: "ubuntu-24-04-x64",
            status,
            ipv4,
            hostId: status === "running" ? id("server", n) : null,
            error: null,
            createdAt: ago(ctx.now, days * 1440),
            destroyedAt: null,
            priceHourly: Math.round((monthly / 730) * 10000) / 10000,
            priceMonthly: monthly,
            currency: provider === "hetzner" ? "EUR" : "USD",
            sinceCreation: Math.round(monthly * Math.min(4, days / 30) * 100) / 100,
            thisMonth: Math.round(monthly * 0.58 * 100) / 100,
            resize: "online" as const
        });
        return {
            overviewAction: () => ({
                ok: true,
                accounts: [
                    {
                        id: DO,
                        provider: "digitalocean",
                        name: ctx.say("Production", "Producción"),
                        lastError: null,
                        organization: null
                    },
                    {
                        id: HZ,
                        provider: "hetzner",
                        name: ctx.say("Backups", "Copias"),
                        lastError: null,
                        organization: null
                    }
                ],
                servers: [
                    server(
                        1,
                        DO,
                        "digitalocean",
                        "web-01",
                        "fra1",
                        "s-2vcpu-4gb",
                        "running",
                        "203.0.113.24",
                        24,
                        120
                    ),
                    server(
                        2,
                        DO,
                        "digitalocean",
                        "worker-01",
                        "ams3",
                        "s-1vcpu-2gb",
                        "running",
                        "203.0.113.57",
                        12,
                        64
                    ),
                    server(
                        3,
                        HZ,
                        "hetzner",
                        "backup-01",
                        "fsn1",
                        "cx22",
                        "running",
                        "198.51.100.12",
                        4.59,
                        210
                    ),
                    server(
                        4,
                        HZ,
                        "hetzner",
                        "build-01",
                        "nbg1",
                        "cpx31",
                        "off",
                        "198.51.100.40",
                        15.59,
                        18
                    )
                ],
                monthTotals: {
                    [DO]: { totals: { USD: 20.88 }, unpriced: 0 },
                    [HZ]: { totals: { EUR: 11.71 }, unpriced: 0 }
                }
            })
        };
    },
    // The page `/apps/servers/cloud` draws: the screen the app serves at its root.
    render: () => (
        <Chrome>
            <div className={PAGE_FILL}>
                <CloudServersScreen />
            </div>
        </Chrome>
    )
});
