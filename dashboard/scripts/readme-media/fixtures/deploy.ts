/** A small shop's services: a site, its API, a worker and two databases. */

import { ago, id } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { ProjectSummary } from "@/app/(app)/apps/deploy/deploy-view";
import type { ShellProject } from "@/app/(app)/apps/deploy/project-shell";
import type { DeploymentSummary } from "@/lib/deploy-service";
import type { StreamLine } from "@/lib/deploy/log-stream";
import type { ProjectCardData } from "@/app/(app)/apps/deploy/projects-grid";

export const PROJECT_ID = id("project", 1);
export const ENVIRONMENT_ID = id("environment", 1);
export const WEB_ID = id("application", 1);
export const WEB_DEPLOYMENT_ID = id("deployment", 1);

export function projectCards(ctx: SceneContext): ProjectCardData[] {
    const say = ctx.say;
    const card = (
        n: number,
        name: string,
        services: ProjectCardData["services"],
        online: number,
        deploying = 0
    ): ProjectCardData => ({
        id: n === 1 ? PROJECT_ID : id("project", n),
        name,
        managed: false,
        environmentName: "production",
        services,
        online,
        deploying,
        total: services.length
    });
    return [
        card(1, "storefront", ["github", "github", "image", "database", "database"], 5),
        card(2, say("marketing-site", "web-marketing"), ["github"], 1),
        card(3, "docs", ["github"], 0, 1),
        card(4, "analytics", ["image", "database"], 2),
        card(5, say("status-page", "pagina-estado"), ["image"], 1),
        card(6, "minecraft", ["image"], 1)
    ];
}

interface ServiceDraft {
    readonly n: number;
    readonly name: string;
    readonly sourceType: "github" | "image";
    readonly hostname?: string;
    readonly port: number;
}

const SERVICES: readonly ServiceDraft[] = [
    { n: 1, name: "web", sourceType: "github", hostname: "shop.example.com", port: 3000 },
    { n: 2, name: "api", sourceType: "github", hostname: "api.shop.example.com", port: 8080 },
    { n: 3, name: "worker", sourceType: "image", port: 9000 }
];

export function projectSummary(): ProjectSummary {
    return {
        id: PROJECT_ID,
        name: "storefront",
        environments: [
            {
                id: ENVIRONMENT_ID,
                name: "production",
                isDefault: true,
                // Where the operator left each card: the request on top, what it
                // calls below, so the lines read left to right.
                layout: JSON.stringify({
                    pos: {
                        [id("application", 1)]: { x: 16, y: 24 },
                        [id("application", 2)]: { x: 312, y: 24 },
                        [id("database", 1)]: { x: 608, y: 24 },
                        [id("application", 3)]: { x: 312, y: 250 },
                        [id("database", 2)]: { x: 608, y: 250 }
                    },
                    links: []
                }),
                referenceEdges: [
                    { source: id("application", 1), target: id("application", 2) },
                    { source: id("application", 2), target: id("database", 1) },
                    { source: id("application", 3), target: id("database", 2) }
                ],
                applications: SERVICES.map((service) => ({
                    id: id("application", service.n),
                    name: service.name,
                    environmentId: ENVIRONMENT_ID,
                    sourceType: service.sourceType,
                    currentDeploymentId: id("deployment", service.n),
                    deployStatus: "running",
                    runState: "running",
                    elsewhere: [],
                    targetId: id("target", 1),
                    serverId: "local",
                    serverName: "Local",
                    containerRef: `storefront-${service.name}`,
                    autoDeploy: service.sourceType === "github",
                    deployBranch: service.sourceType === "github" ? "main" : null,
                    commitFilter: null,
                    watchPaths: null,
                    keepReleases: false,
                    rootDirectory: null,
                    dockerfilePath: null,
                    installCommand: null,
                    buildCommand: null,
                    startCommand: null,
                    runtimeVersion: null,
                    outputDirectory: null,
                    replicas: 1,
                    port: service.port,
                    ipUrl: null,
                    domains: service.hostname
                        ? [
                              {
                                  id: id("domain", service.n),
                                  hostname: service.hostname,
                                  kind: "custom",
                                  enabled: true,
                                  healthStatus: "healthy",
                                  healthCode: 200,
                                  healthDetail: null,
                                  hasCertificate: false,
                                  servedBy: "server",
                                  cdn: false,
                                  targetPort: service.port
                              }
                          ]
                        : [],
                    volumes: []
                })),
                databases: [
                    {
                        id: id("database", 1),
                        name: "postgres",
                        engine: "postgres",
                        status: "running"
                    },
                    { id: id("database", 2), name: "redis", engine: "redis", status: "running" }
                ]
            }
        ]
    };
}

export function shellProject(ctx: SceneContext): ShellProject {
    const summary = projectSummary();
    return {
        id: PROJECT_ID,
        name: summary.name,
        environments: [{ id: ENVIRONMENT_ID, name: "production", isDefault: true }],
        glance: {
            [ENVIRONMENT_ID]: {
                addresses: SERVICES.filter((service) => service.hostname).map((service) => ({
                    id: id("domain", service.n),
                    hostname: service.hostname!,
                    kind: "custom",
                    enabled: true,
                    healthStatus: "healthy",
                    applicationId: id("application", service.n),
                    service: service.name
                })),
                lastDeploy: {
                    applicationId: WEB_ID,
                    service: "web",
                    status: "running",
                    createdAt: ago(ctx.now, 12)
                },
                attention: []
            }
        }
    };
}

/** The web service's releases, newest first: pushes to main, one that failed. */
export function deployments(ctx: SceneContext): DeploymentSummary[] {
    const say = ctx.say;
    const release = (
        n: number,
        minutesAgo: number,
        message: string,
        sha: string,
        author: string,
        status = "running",
        extra: Partial<DeploymentSummary> = {}
    ): DeploymentSummary => ({
        id: id("deployment", n),
        status,
        error: null,
        createdAt: ago(ctx.now, minutesAgo),
        isCurrent: n === 1,
        commitMessage: message,
        commitSha: sha,
        authorName: author,
        authorAvatarUrl: null,
        commitUrl: null,
        hostname: null,
        rollbackable: status === "running" || status === "removed",
        imageKept: true,
        pinned: false,
        rollbackOfId: null,
        trigger: "push",
        durationMs: 71_000 + n * 4_000,
        canTakeTraffic: false,
        trafficPercent: null,
        builtOn: null,
        ...extra
    });
    return [
        release(
            1,
            12,
            say("Checkout: remember the shipping address", "Pago: recordar la dirección de envío"),
            "8f3c2a1d9e",
            "Ana Torres"
        ),
        release(
            4,
            190,
            say(
                "Product page loads images lazily",
                "La página de producto carga las imágenes al vuelo"
            ),
            "c41b7e09aa",
            "Kenji Mori",
            "removed"
        ),
        release(
            5,
            230,
            say("Bump the payment SDK", "Actualizar el SDK de pagos"),
            "1e9d44f0b2",
            "Sam Okafor",
            "failed",
            {
                imageKept: false,
                error: say(
                    "Build failed: type error in checkout/summary.tsx",
                    "La compilación falló: error de tipos en checkout/summary.tsx"
                )
            }
        ),
        release(
            6,
            60 * 26,
            say("Sale banner on the home page", "Banner de rebajas en la portada"),
            "7a20c3d5e1",
            "Lena Fischer",
            "removed"
        )
    ];
}

/** What the web service printed since its release started, as the log stream sends it. */
export function webLog(ctx: SceneContext): StreamLine[] {
    const started = ctx.now - 12 * 60_000 + 74_000;
    const lines: [number, string][] = [
        [0, "> storefront@2.4.0 start"],
        [1, "> next start -p 3000"],
        [400, "  \u25B2 Next.js"],
        [410, "  - Local:        http://localhost:3000"],
        [420, "  - Network:      http://172.18.0.7:3000"],
        [900, " \u2713 Starting..."],
        [1600, " \u2713 Ready in 1183ms"],
        [5200, "[db] connected to postgres:5432 (pool 10)"],
        [5300, "[cache] connected to redis:6379"],
        [61_000, "GET /  200  in 84ms"],
        [62_500, "GET /products/linen-shirt  200  in 112ms"],
        [63_100, "POST /api/cart  201  in 46ms"],
        [95_000, "GET /checkout  200  in 97ms"],
        [96_200, "POST /api/checkout/address  200  in 63ms"],
        [96_900, "[checkout] saved shipping address for next order"],
        [130_000, "GET /  200  in 71ms"],
        [180_400, "GET /products?category=summer  200  in 138ms"],
        [240_000, "POST /api/checkout/pay  200  in 412ms"],
        [240_500, "[orders] order 10482 paid, 3 items"],
        [300_000, "GET /account/orders  200  in 88ms"]
    ];
    return lines.map(([offset, text]) => ({
        serviceId: WEB_ID,
        container: "storefront-web",
        stamp: new Date(started + offset).toISOString(),
        text
    }));
}
