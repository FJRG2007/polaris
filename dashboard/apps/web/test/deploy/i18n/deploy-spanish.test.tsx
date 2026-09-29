/**
 * Deploy in Spanish: the words a reader sees on a service's panel come from the
 * catalogs, plurals and arguments included, and the English stays what it was.
 */

import { describe, expect, it } from "vitest";
import { withMessages } from "../../setup/i18n";
import { webCatalogs } from "../../../messages";
import { renderToStaticMarkup } from "react-dom/server";
import { deploySteps } from "@/lib/deploy/deploy-steps";
import type { ActivityLine } from "@/lib/activity/activity";
import { tabAttention } from "@/app/(app)/apps/deploy/attention-dot";
import { DeployStepper } from "@/app/(app)/apps/deploy/deploy-stepper";
import { describeServiceEvent } from "@/app/(app)/apps/deploy/service-history";
import { DatabaseTopologyField } from "@/app/(app)/apps/deploy/database-topology-field";

const MIDWAY = "==> Fetching the source...\n==> Fetching the source: 2.0s\n==> Building the image...\n";

function line(overrides: Partial<ActivityLine> = {}): ActivityLine {
    return {
        id: "l1",
        action: "deployed",
        fromValue: null,
        toValue: null,
        authorName: "Ana",
        createdAt: "2026-08-15T10:00:00.000Z",
        ...overrides
    };
}

describe("Deploy in Spanish", () => {
    it("names each deploy step and its state", () => {
        const html = renderToStaticMarkup(
            withMessages(<DeployStepper steps={deploySteps("deploying", MIDWAY)} />, "es-ES")
        );
        expect(html).toContain('aria-label="Clonar: hecho"');
        expect(html).toContain('aria-label="Compilar: en curso"');
        expect(html).toContain('aria-label="Progreso"');
    });

    it("counts a sharded cluster's containers with the argument in place", () => {
        const html = renderToStaticMarkup(
            withMessages(
                <DatabaseTopologyField engine="mongo" value={{ topology: "sharded", shards: 2 }} onChange={() => undefined} />,
                "es-ES"
            )
        );
        expect(html).toContain("10 contenedores");
        expect(html).toContain("Con shards");
    });

    it("tells a service's history and its attention dots in Spanish", () => {
        const t = webCatalogs.translator("es-ES", "deployService");
        expect(describeServiceEvent(line(), t)).toBe("Ana lo desplegó");
        expect(describeServiceEvent(line({ authorName: null, action: "autoscaled-cpu", fromValue: "3", toValue: "1" }), t)).toBe(
            "Polaris lo escaló de 3 a 1 copia: CPU baja"
        );
        expect(tabAttention({ deployFailed: true, domainDown: false, cronFailing: true }, t)).toEqual({
            Deployments: "El último despliegue falló",
            Cron: "Una tarea programada falla"
        });
    });

    it("keeps the English as it was", () => {
        const t = webCatalogs.translator("en-US", "deployService");
        expect(describeServiceEvent(line({ action: "variable", toValue: "DATABASE_URL" }), t)).toBe(
            "Ana changed the DATABASE_URL variable"
        );
    });
});
