/** Security scans: what was checked on each server, and what it found. */

import { PAGE_FILL } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { ago, id } from "../fixtures/people";
import { defineScene } from "../runtime/scene";
import { SecurityView } from "../../../apps/security-scans/src/screens/security-view";

const HOST = id("server", 1);

export const securityScans = defineScene({
    id: "security-scans",
    path: "/apps/servers/security",
    actions: (ctx) => {
        const at = (minutes: number) => new Date(Date.parse(ago(ctx.now, minutes)));
        const scan = (n: number, kind: string, label: string, minutes: number, summary: Record<string, unknown>) => ({
            id: id("security-scan", n),
            kind,
            label,
            state: "done",
            summary,
            error: null,
            createdAt: at(minutes),
            finishedAt: at(minutes - 3),
            subject: kind === "audit" ? "server" : "volume"
        });
        return {
            // No image or dependency scan is waiting on a decision: no focus card.
            focusAction: () => ({ ok: true, data: null }),
            serversAction: () => ({
                ok: true,
                data: [
                    { id: HOST, name: ctx.say("This machine", "Esta máquina"), local: true, everyHours: 24, updates: "security", distro: "Ubuntu 24.04" },
                    { id: id("server", 2), name: "edge-01", local: false, everyHours: 24, updates: "all", distro: "Debian 12" }
                ]
            }),
            overviewAction: () => ({
                ok: true,
                data: {
                    volumes: [
                        { id: id("volume", 1), label: "shop / uploads" },
                        { id: id("volume", 2), label: "wiki / data" }
                    ],
                    apps: [
                        { id: id("app", 1), name: "shop" },
                        { id: id("app", 2), name: "wiki" }
                    ],
                    scans: [
                        scan(1, "malware", "shop / uploads", 95, { found: 0 }),
                        scan(2, "malware", "wiki / data", 98, { found: 1 }),
                        scan(3, "files", "shop / uploads", 160, { mode: "check", added: 4, removed: 0, changed: 1 }),
                        scan(4, "audit", ctx.say("This machine", "Esta máquina"), 1440, { score: 82, warnings: 3 })
                    ],
                    quarantine: [
                        {
                            id: id("quarantine", 1),
                            volumeId: id("volume", 2),
                            path: "uploads/invoice.pdf.js",
                            signature: "Js.Trojan.Agent-1234",
                            createdAt: at(96)
                        }
                    ],
                    baselines: [
                        {
                            id: id("baseline", 1),
                            volumeId: id("volume", 1),
                            subpath: "",
                            label: "shop / uploads",
                            files: 1284,
                            createdAt: at(10080)
                        }
                    ]
                }
            })
        };
    },
    // The page `/apps/servers/security` draws with no scan linked.
    render: () => (
        <Chrome>
            <div className={PAGE_FILL}>
                <SecurityView />
            </div>
        </Chrome>
    )
});
