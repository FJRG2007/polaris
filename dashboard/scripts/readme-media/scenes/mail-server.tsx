/** Mail server: the mail servers Polaris runs, each with its domain and machine. */

import { PageHeader } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { ago, id } from "../fixtures/people";
import { defineScene } from "../runtime/scene";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { MailServersView } from "@/app/(app)/apps/mail-server/mail-servers-view";

/** The page `/apps/mail-server` draws once the app is installed. */
function MailServer() {
    const t = useTranslations("mailServer");
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col">
            <PageHeader title={t("page.title")} description={t("page.description")} />
            <MailServersView canUninstall />
        </div>
    );
}

export const mailServer = defineScene({
    id: "mail-server",
    path: "/apps/mail-server",
    actions: (ctx) => ({
        listServersAction: () => ({
            servers: [
                { hostname: "mail.example.com", domain: "example.com", status: "ready", place: "", days: 92 },
                { hostname: "mx.example.org", domain: "example.org", status: "ready", place: "edge-01", days: 31 },
                { hostname: "mail.example.net", domain: "example.net", status: "starting", place: "edge-02", days: 0 }
            ].map((server, n) => ({
                id: id("mail-server", n + 1),
                hostname: server.hostname,
                primaryDomain: server.domain,
                status: server.status,
                step: server.status === "ready" ? "done" : "certificates",
                error: null,
                placement: n === 0 ? "local" : id("server", n),
                placementName: server.place || ctx.say("This machine", "Esta máquina"),
                createdAt: ago(ctx.now, server.days * 1440 + 45)
            }))
        })
    }),
    render: () => (
        <Chrome>
            <MailServer />
        </Chrome>
    )
});
