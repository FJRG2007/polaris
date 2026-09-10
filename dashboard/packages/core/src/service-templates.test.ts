/**
 * The one-click services: each is whole, its variables come out as the service
 * stores them, and its setup runs in the order the catalog gives.
 */

import { describe, expect, it } from "vitest";
import { DB_ENGINE_INFO } from "./schemas/database.js";
import { hasReferences, referencesIn } from "./deploy-references.js";
import {
    freeTemplateName,
    runPrepareSteps,
    serviceTemplate,
    templateNeedsSetup,
    templateVariables,
    SERVICE_TEMPLATES,
    type PrepareExecResult,
    type TemplatePrepareStep,
    type TemplateService
} from "./service-templates.js";

/** What the variables service accepts as a key; anything else is skipped. */
const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function containers(): { id: string; service: TemplateService }[] {
    return SERVICE_TEMPLATES.flatMap((template) => [
        { id: template.id, service: template },
        ...(template.companion
            ? [{ id: `${template.id} companion`, service: template.companion }]
            : [])
    ]);
}

describe("the template list", () => {
    it("names each template once, with an image, a port and mount paths that are paths", () => {
        const ids = SERVICE_TEMPLATES.map((template) => template.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const { service } of containers()) {
            expect(service.image).toMatch(/^[a-z0-9./_-]+(:[\w.-]+)?$/);
            expect(service.port).toBeGreaterThan(0);
            for (const volume of service.volumes)
                expect(volume.mountPath.startsWith("/")).toBe(true);
            // A secret is generated, never also written as a plain value.
            for (const key of service.secrets) expect(service.env[key]).toBeUndefined();
        }
    });

    it("uses only keys the variables service stores", () => {
        for (const { id, service } of containers()) {
            for (const key of [...Object.keys(service.env), ...service.secrets]) {
                expect(key, `${id}: ${key}`).toMatch(VARIABLE_KEY);
            }
        }
    });

    it("asks for database versions Polaris offers", () => {
        for (const template of SERVICE_TEMPLATES) {
            if (!template.database) continue;
            expect(DB_ENGINE_INFO[template.database.engine].versions).toContain(
                template.database.version
            );
        }
    });

    it("gives every setup step a title, a command and a bounded readiness test", () => {
        for (const template of SERVICE_TEMPLATES) {
            for (const step of template.prepare ?? []) {
                expect(step.title.trim()).not.toBe("");
                expect(step.command.trim()).not.toBe("");
                expect(step.readiness.test.trim()).not.toBe("");
                expect(step.readiness.retries).toBeGreaterThan(0);
                expect(step.readiness.intervalMs).toBeGreaterThan(0);
            }
        }
    });

    it("wires every placeholder a template writes to something it creates", () => {
        for (const template of SERVICE_TEMPLATES) {
            const slugs = {
                self: template.id,
                ...(template.database ? { database: `${template.id}-db` } : {}),
                ...(template.companion
                    ? { companion: `${template.id}-${template.companion.suffix}` }
                    : {})
            };
            const vars = [
                ...templateVariables(template, slugs, () => "x"),
                ...(template.companion
                    ? templateVariables(template.companion, { self: slugs.companion! }, () => "x")
                    : [])
            ];
            // Nothing is left in the template's own notation: every `{{` is the
            // start of a `${{...}}` reference.
            for (const entry of vars)
                expect(entry.value, `${template.id}: ${entry.key}`).not.toMatch(/(^|[^$])\{\{/);
        }
    });

    it("marks the apps other sites frame, and only those", () => {
        const embedded = SERVICE_TEMPLATES.filter((template) => template.embedded).map(
            (template) => template.id
        );
        expect(embedded.sort()).toEqual(["grafana", "metabase", "n8n", "uptime-kuma"]);
    });
});

describe("the templates added with a database, a companion or setup", () => {
    it("transcribes Ghost with a MySQL database it reaches by reference", () => {
        const ghost = serviceTemplate("ghost")!;
        expect(ghost).toMatchObject({
            image: "ghost:5-alpine",
            port: 2368,
            database: { engine: "mysql" }
        });
        expect(ghost.volumes).toEqual([{ name: "content", mountPath: "/var/lib/ghost/content" }]);
        expect(templateNeedsSetup(ghost)).toBe(true);
    });

    it("transcribes Umami with a PostgreSQL 16 database and a generated app secret", () => {
        const umami = serviceTemplate("umami")!;
        expect(umami).toMatchObject({
            image: "ghcr.io/umami-software/umami:postgresql-v2.19.0",
            port: 3000,
            database: { engine: "postgres", version: "16" },
            secrets: ["APP_SECRET"]
        });
    });

    it("transcribes Gitea, FreshRSS and MinIO with the catalog's setup commands", () => {
        const gitea = serviceTemplate("gitea")!;
        expect(gitea).toMatchObject({ image: "gitea/gitea:1", port: 3000 });
        expect(gitea.prepare?.[0]?.readiness).toEqual({
            test: "su-exec git gitea admin user list >/dev/null 2>&1",
            intervalMs: 3000,
            retries: 40
        });
        expect(gitea.prepare?.[0]?.command).toContain("gitea admin user create --admin");

        const freshrss = serviceTemplate("freshrss")!;
        expect(freshrss).toMatchObject({ image: "freshrss/freshrss:latest", port: 80 });
        expect(freshrss.prepare?.[0]?.readiness).toEqual({
            test: "test -d /var/www/FreshRSS/cli",
            intervalMs: 3000,
            retries: 30
        });

        const minio = serviceTemplate("minio")!;
        expect(minio).toMatchObject({ image: "minio/minio:latest", port: 9001 });
        expect(minio.command).toEqual(["server", "/data", "--console-address", ":9001"]);
        expect(minio.prepare?.[0]?.readiness).toMatchObject({ intervalMs: 1000, retries: 30 });
        expect(minio.prepare?.[0]?.command).toContain(
            'mc mb --ignore-existing "local/$OPENSHIP_BUCKET"'
        );
    });

    it("transcribes Kafka as its console and a broker companion", () => {
        const kafka = serviceTemplate("kafka")!;
        expect(kafka).toMatchObject({ image: "ghcr.io/kafbat/kafka-ui:latest", port: 8080 });
        expect(kafka.companion).toMatchObject({
            suffix: "broker",
            image: "apache/kafka:4.0.0",
            port: 9092
        });
        expect(kafka.companion?.volumes).toEqual([
            { name: "data", mountPath: "/var/lib/kafka/data" }
        ]);
    });

    it("leaves the plain templates as one deploy of one container", () => {
        expect(templateNeedsSetup(serviceTemplate("n8n")!)).toBe(false);
    });
});

describe("templateVariables", () => {
    it("writes the public address as a reference to the service itself", () => {
        const vars = templateVariables(serviceTemplate("n8n")!, { self: "automations" }, () => "x");
        const webhook = vars.find((entry) => entry.key === "WEBHOOK_URL");
        expect(webhook?.value).toBe("${{automations.POLARIS_PUBLIC_URL}}");
        expect(hasReferences(webhook?.value ?? "")).toBe(true);
        expect(referencesIn(webhook?.value ?? "")[0]).toMatchObject({
            name: "automations",
            key: "POLARIS_PUBLIC_URL"
        });
    });

    it("generates each secret and marks it secret", () => {
        let n = 0;
        const vars = templateVariables(
            serviceTemplate("vaultwarden")!,
            { self: "vault" },
            () => `secret-${++n}`
        );
        expect(vars.find((entry) => entry.key === "ADMIN_TOKEN")).toEqual({
            key: "ADMIN_TOKEN",
            value: "secret-1",
            isSecret: true
        });
        expect(vars.find((entry) => entry.key === "SIGNUPS_ALLOWED")?.isSecret).toBe(false);
    });

    it("points a service at its database by reference and copies nothing secret", () => {
        const generated: string[] = [];
        const vars = templateVariables(
            serviceTemplate("ghost")!,
            { self: "blog", database: "blog-db" },
            () => {
                generated.push("g");
                return "g";
            }
        );
        const value = (key: string) => vars.find((entry) => entry.key === key)?.value;

        expect(value("database__connection__host")).toBe("${{blog-db.HOST}}");
        expect(value("database__connection__user")).toBe("${{blog-db.USER}}");
        expect(value("database__connection__password")).toBe("${{blog-db.PASSWORD}}");
        expect(value("database__connection__database")).toBe("${{blog-db.DATABASE}}");
        expect(value("url")).toBe("${{blog.POLARIS_PUBLIC_URL}}");
        // The password is read from the database when the service deploys; no
        // value was generated or stored for it.
        expect(generated).toEqual([]);
        expect(vars.every((entry) => !entry.isSecret)).toBe(true);

        const umami = templateVariables(
            serviceTemplate("umami")!,
            { self: "stats", database: "stats-db" },
            () => "s"
        );
        expect(umami.find((entry) => entry.key === "DATABASE_URL")?.value).toBe(
            "${{stats-db.DATABASE_URL}}"
        );
    });

    it("points a console at its companion, and the companion at itself", () => {
        const kafka = serviceTemplate("kafka")!;
        const ui = templateVariables(
            kafka,
            { self: "events", companion: "events-broker" },
            () => "p"
        );
        expect(ui.find((entry) => entry.key === "KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS")?.value).toBe(
            "${{events-broker.POLARIS_PRIVATE_DOMAIN}}:9092"
        );
        const broker = templateVariables(kafka.companion!, { self: "events-broker" }, () => "p");
        expect(broker.find((entry) => entry.key === "KAFKA_CONTROLLER_QUORUM_VOTERS")?.value).toBe(
            "1@${{events-broker.POLARIS_PRIVATE_DOMAIN}}:9093"
        );
    });

    it("refuses a placeholder for something the caller did not create", () => {
        expect(() =>
            templateVariables(serviceTemplate("ghost")!, { self: "blog" }, () => "x")
        ).toThrow(/database/);
    });
});

describe("freeTemplateName", () => {
    it("takes the name as it is when nothing holds it, and numbers past what does", () => {
        expect(freeTemplateName("blog-db", new Set(["blog"]))).toBe("blog-db");
        expect(freeTemplateName("blog-db", new Set(["blog-db", "blog-db-2"]))).toBe("blog-db-3");
    });
});

describe("runPrepareSteps", () => {
    const step = (overrides: Partial<TemplatePrepareStep> = {}): TemplatePrepareStep => ({
        title: "Create the admin",
        command: "create",
        readiness: { test: "ready?", intervalMs: 3000, retries: 4 },
        ...overrides
    });

    /** An exec that answers from a script, recording each command and each wait. */
    function fake(answers: Record<string, (PrepareExecResult | Error)[]>) {
        const calls: string[] = [];
        const waits: number[] = [];
        const exec = async (command: string): Promise<PrepareExecResult> => {
            calls.push(command);
            const next = answers[command]?.shift() ?? { code: 0, output: "" };
            if (next instanceof Error) throw next;
            return next;
        };
        const sleep = async (ms: number) => {
            waits.push(ms);
        };
        return { calls, waits, exec, sleep };
    }

    it("polls the readiness test until it passes, then runs the command once", async () => {
        const run = fake({
            "ready?": [{ code: 1, output: "" }, new Error("restarting"), { code: 0, output: "" }],
            create: [{ code: 0, output: "  uploads\n" }]
        });
        const outcomes = await runPrepareSteps([step()], run.exec, run.sleep);

        expect(run.calls).toEqual(["ready?", "ready?", "ready?", "create"]);
        expect(run.waits).toEqual([3000, 3000]);
        expect(outcomes).toEqual([{ ok: true, title: "Create the admin", output: "uploads" }]);
    });

    it("gives up after the retries and never runs the command", async () => {
        const run = fake({ "ready?": Array.from({ length: 4 }, () => ({ code: 1, output: "" })) });
        const outcomes = await runPrepareSteps([step()], run.exec, run.sleep);

        expect(run.calls).toEqual(["ready?", "ready?", "ready?", "ready?"]);
        // No wait after the last check: there is nothing left to wait for.
        expect(run.waits).toHaveLength(3);
        expect(outcomes).toEqual([
            {
                ok: false,
                title: "Create the admin",
                reason: "It was not ready after 4 checks 3 seconds apart.",
                output: ""
            }
        ]);
    });

    it("reports a command that exits non-zero with what it printed", async () => {
        const run = fake({ create: [{ code: 2, output: "no such bucket\n" }] });
        const outcomes = await runPrepareSteps([step()], run.exec, run.sleep);

        expect(outcomes).toEqual([
            {
                ok: false,
                title: "Create the admin",
                reason: "It exited with code 2.",
                output: "no such bucket"
            }
        ]);
    });

    it("reports a command that could not be run, in the words it failed with", async () => {
        const run = fake({ create: [new Error("It did not finish within 5 minutes.")] });
        const [outcome] = await runPrepareSteps([step()], run.exec, run.sleep);

        expect(outcome).toMatchObject({ ok: false, reason: "It did not finish within 5 minutes." });
    });

    it("runs the steps in order and stops at the first that fails", async () => {
        const run = fake({ first: [{ code: 1, output: "" }] });
        const outcomes = await runPrepareSteps(
            [step({ title: "One", command: "first" }), step({ title: "Two", command: "second" })],
            run.exec,
            run.sleep
        );

        expect(run.calls).not.toContain("second");
        expect(outcomes.map((outcome) => outcome.title)).toEqual(["One"]);
    });
});
