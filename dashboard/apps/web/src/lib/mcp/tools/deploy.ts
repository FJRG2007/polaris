/**
 * Deploy, as tools an agent can call.
 *
 * The same operations as the Deploy REST API and the CLI, through the same
 * module (`lib/deploy/api/surface.ts`), so an agent reaches exactly what the
 * person whose key it holds could reach from the dashboard - the key's scope and
 * the project capability are both asked, every time, and a project token stays
 * inside its project.
 *
 * A service is named the way a person names it - `project/service`, or
 * `project/environment/service` - so an agent that was told "deploy the API"
 * does not need a lookup first. Ambiguity is refused with the candidates named
 * rather than resolved by a guess.
 *
 * Deliberately not offered: reading a variable's value, secret or plain. An
 * agent that needs one to do its work should be given it by a person; handing it
 * a tool that prints them puts every secret it can reach one prompt injection
 * away from a public issue comment. So the listings name variables and nothing
 * more, and a value an agent writes is never repeated back in what it reads.
 */

import { z } from "zod";
import * as surface from "@/lib/deploy/api/surface";
import { publicFailure } from "@/lib/deploy/api/refusal";
import { isMcpOnlyScope } from "../scope-table";
import type { Permission } from "@polaris/core";
import { McpRefusal, type McpCaller, type McpTool } from "../protocol";
import { defineMcpSearch } from "../search";
import {
    addDomainSchema,
    putVariableSchema,
    serviceRefSchema,
    setVariableSchema,
    variableKeySchema
} from "@/lib/deploy/api/schemas";

/** The deploy caller for an MCP call. */
function deployCaller(caller: McpCaller): surface.DeployCaller {
    return {
        userId: caller.userId,
        // The Deploy API reads permissions; a finer MCP scope is none of its.
        scopes: caller.scopes.filter((scope): scope is Permission => !isMcpOnlyScope(scope)),
        keyId: caller.keyId ?? null,
        projectId: caller.projectId ?? null,
        via: "mcp"
    };
}

/**
 * Run an operation, turning what it refused into a refusal the model reads.
 *
 * The same split the REST API makes: a refusal written for the caller reaches
 * the model as written, and anything from beneath the service layer is
 * rethrown for the protocol to log and replace with its own sentence.
 */
async function attempt<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        const failure = publicFailure(caught, operation);
        if (failure.status !== 500) throw new McpRefusal(failure.message);
        throw caught;
    }
}

const serviceInput = z.object({
    service: serviceRefSchema.describe(
        "The service: its id, project/service (the default environment) or project/environment/service."
    )
});

const projectsInput = z.object({});

const projectsTool: McpTool<z.infer<typeof projectsInput>> = {
    name: "deploy_projects",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List Deploy projects",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Every Deploy project this key can reach, with each environment's services and what they are doing. Start here to find the name of a service.",
    input: projectsInput,
    category: "development",
    scope: "deploy.read",
    readOnly: true,
    async run(_input, caller) {
        const projects = await attempt("list the projects", () =>
            surface.listProjects(deployCaller(caller))
        );
        const lines = projects.flatMap((project) =>
            project.environments.flatMap((environment) =>
                environment.services.map(
                    (service) =>
                        `${project.slug}/${environment.slug}/${service.slug}  [${service.status}]  ${service.id}`
                )
            )
        );
        return {
            text: lines.length > 0 ? lines.join("\n") : "No projects this key can reach.",
            structured: { projects }
        };
    }
};

const serviceTool: McpTool<z.infer<typeof serviceInput>> = {
    name: "deploy_service",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Read a service",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "One service: where its code or image comes from, whether it is running, and the hostnames it answers on.",
    input: serviceInput,
    category: "development",
    scope: "deploy.read",
    readOnly: true,
    async run(input, caller) {
        const service = await attempt("read the service", () =>
            surface.getService(deployCaller(caller), input.service)
        );
        return {
            text: [
                `${service.project.slug}/${service.environment.slug}/${service.slug} - ${service.status}`,
                `Source: ${service.source.image ?? service.source.repository ?? service.source.kind}${
                    service.source.branch ? ` (${service.source.branch})` : ""
                }`,
                `Domains: ${service.domains.map((domain) => domain.hostname).join(", ") || "none"}`,
                `Current deployment: ${service.currentDeploymentId ?? "none"}`
            ].join("\n"),
            structured: { service }
        };
    }
};

const startTool: McpTool<z.infer<typeof serviceInput>> = {
    name: "deploy_start",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Deploy a service",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Deploy a service from its configured source. Returns at once with the deployment id; read its progress with deploy_deployment. Does not change how the service is built.",
    input: serviceInput,
    category: "development",
    scope: "deploy.manage",
    readOnly: false,
    async run(input, caller) {
        const { deploymentId } = await attempt("deploy the service", () =>
            surface.deploy(deployCaller(caller), input.service)
        );
        return {
            text: `Deployment ${deploymentId} started. Read it with deploy_deployment.`,
            structured: { deploymentId }
        };
    }
};

const deploymentsTool: McpTool<z.infer<typeof serviceInput>> = {
    name: "deploy_deployments",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List deployments",
    // i18n-ignore read by the calling model, not shown to a person
    description: "A service's recent deployments, newest first, with status and commit.",
    input: serviceInput,
    category: "development",
    scope: "deploy.read",
    readOnly: true,
    async run(input, caller) {
        const deployments = await attempt("list the deployments", () =>
            surface.listDeployments(deployCaller(caller), input.service)
        );
        return {
            text:
                deployments
                    .map((row) =>
                        `${row.id}  ${row.status}${row.isCurrent ? " (current)" : ""}${
                            row.rollbackable && !row.isCurrent ? " (can roll back)" : ""
                        }  ${row.createdAt}  ${row.commitSha?.slice(0, 7) ?? ""} ${
                            row.commitMessage?.split("\n")[0] ?? ""
                        }`.trimEnd()
                    )
                    .join("\n") || "This service has never been deployed.",
            structured: { deployments }
        };
    }
};

const deploymentInput = z.object({
    deploymentId: z.string().uuid(),
    tail: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(80)
        .describe("How many of the build log's last lines to include.")
});

const deploymentTool: McpTool<z.infer<typeof deploymentInput>> = {
    name: "deploy_deployment",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Read a deployment",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "A deployment's status and the end of its build log - what to read when a deploy failed, or to see whether it has finished.",
    input: deploymentInput,
    category: "development",
    scope: "deploy.read",
    readOnly: true,
    async run(input, caller) {
        const result = await attempt("read the deployment", () =>
            surface.deploymentLog(deployCaller(caller), input.deploymentId, { tail: input.tail })
        );
        return {
            text: [
                `Status: ${result.status}${result.done ? "" : " (still running)"}`,
                ...(result.error ? [`Error: ${result.error}`] : []),
                "",
                result.log
            ].join("\n"),
            structured: result
        };
    }
};

const logsInput = serviceInput.extend({
    tail: z.number().int().min(1).max(2000).default(200).describe("How many recent lines to read.")
});

const logsTool: McpTool<z.infer<typeof logsInput>> = {
    name: "deploy_logs",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Read a service's logs",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "What a service's running container has printed recently. For a failed build use deploy_deployment instead - this is the app's own output.",
    input: logsInput,
    category: "development",
    scope: "deploy.read",
    readOnly: true,
    async run(input, caller) {
        const { log } = await attempt("read the service's logs", () =>
            surface.runtimeLog(deployCaller(caller), input.service, { tail: input.tail })
        );
        return {
            text: log || "The container has printed nothing, or is not running.",
            structured: { log }
        };
    }
};

/** A listing of names, as the model reads it. */
async function variableNames(caller: McpCaller, service: string) {
    const variables = await attempt("list the variables", () =>
        surface.listVariableNames(deployCaller(caller), { kind: "service", ref: service })
    );
    return {
        text:
            variables
                .map(
                    (row) =>
                        `${row.key}${row.isSecret ? " (secret)" : ""}  updated ${row.updatedAt}`
                )
                .join("\n") || "No variables.",
        structured: { variables }
    };
}

const variablesTool: McpTool<z.infer<typeof serviceInput>> = {
    name: "deploy_variables",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List variables",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "A service's environment variables by name, with whether each is secret and when it changed. No value is ever shown. Same as env_list.",
    input: serviceInput,
    category: "development",
    scope: "deploy.read",
    readOnly: true,
    run: (input, caller) => variableNames(caller, input.service)
};

const envListTool: McpTool<z.infer<typeof serviceInput>> = {
    name: "env_list",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List environment variables",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "A service's environment variable names, with whether each is secret and when it changed. Values are never returned, so do not ask for them.",
    input: serviceInput,
    category: "development",
    scope: "deploy.read",
    readOnly: true,
    run: (input, caller) => variableNames(caller, input.service)
};

const envSetInput = serviceInput
    .extend({ name: variableKeySchema.describe("The variable's name, e.g. DATABASE_URL.") })
    .merge(putVariableSchema);

const envSetTool: McpTool<z.infer<typeof envSetInput>> = {
    name: "env_set",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Set an environment variable",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Create or replace one environment variable on a service (secret by default). Write-only: the value is stored and never returned. The running service keeps its old value until it is redeployed: pass redeploy to do that now.",
    input: envSetInput,
    category: "development",
    scope: "deploy.manage",
    readOnly: false,
    async run(input, caller) {
        const { created, redeployed } = await attempt("save the variable", () =>
            surface.setVariable(
                deployCaller(caller),
                { kind: "service", ref: input.service },
                {
                    key: input.name,
                    value: input.value,
                    secret: input.secret,
                    redeploy: input.redeploy
                }
            )
        );
        const verb = created ? "created" : "replaced";
        return {
            text: redeployed
                ? `${input.name} is ${verb}. The service redeploys to pick it up if it is running.`
                : `${input.name} is ${verb}. The service picks it up on its next deploy.`,
            structured: { name: input.name, created, redeployed }
        };
    }
};

const envDeleteInput = serviceInput.extend({
    name: variableKeySchema.describe("The variable's name."),
    redeploy: putVariableSchema.shape.redeploy
});

const envDeleteTool: McpTool<z.infer<typeof envDeleteInput>> = {
    name: "env_delete",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Delete an environment variable",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Remove one environment variable from a service by name. The running service keeps it until it is redeployed: pass redeploy to do that now.",
    input: envDeleteInput,
    category: "development",
    scope: "deploy.manage",
    readOnly: false,
    async run(input, caller) {
        const { redeployed } = await attempt("remove the variable", () =>
            surface.deleteVariableNamed(
                deployCaller(caller),
                { kind: "service", ref: input.service },
                input.name,
                { redeploy: input.redeploy }
            )
        );
        return {
            text: redeployed
                ? `${input.name} is removed. The service redeploys without it.`
                : `${input.name} is removed. The service drops it on its next deploy.`,
            structured: { name: input.name, removed: true, redeployed }
        };
    }
};

const setVariableInput = serviceInput.merge(setVariableSchema);

const setVariableTool: McpTool<z.infer<typeof setVariableInput>> = {
    name: "deploy_set_variable",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Set a variable",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Set one environment variable on a service (secret by default). The running service keeps its old value until it is redeployed: pass redeploy to do that now, or deploy once after setting several.",
    input: setVariableInput,
    category: "development",
    scope: "deploy.manage",
    readOnly: false,
    // Not idempotent: with redeploy set, every call starts another deployment.
    async run(input, caller) {
        const { redeployed } = await attempt("save the variable", () =>
            surface.setVariable(
                deployCaller(caller),
                { kind: "service", ref: input.service },
                {
                    key: input.key,
                    value: input.value,
                    secret: input.secret,
                    redeploy: input.redeploy
                }
            )
        );
        return {
            text: redeployed
                ? `${input.key} is saved. The service redeploys to pick it up if it is running.`
                : `${input.key} is saved. The service picks it up on its next deploy.`,
            structured: { key: input.key, redeployed }
        };
    }
};

const domainsTool: McpTool<z.infer<typeof serviceInput>> = {
    name: "deploy_domains",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List domains",
    // i18n-ignore read by the calling model, not shown to a person
    description: "The hostnames a service answers on, with whether each is enabled and reachable.",
    input: serviceInput,
    category: "development",
    scope: "deploy.read",
    readOnly: true,
    async run(input, caller) {
        const domains = await attempt("list the domains", () =>
            surface.listDomains(deployCaller(caller), input.service)
        );
        return {
            text:
                domains
                    .map(
                        (row) =>
                            `${row.hostname}  ${row.enabled ? "enabled" : "disabled"}  ${row.health}  -> :${row.targetPort}`
                    )
                    .join("\n") || "No domains.",
            structured: { domains }
        };
    }
};

const addDomainInput = serviceInput.merge(addDomainSchema);

const addDomainTool: McpTool<z.infer<typeof addDomainInput>> = {
    name: "deploy_add_domain",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Attach a domain",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Attach a hostname to a service, or its free subdomain when no hostname is given. Does not buy or register a domain.",
    input: addDomainInput,
    category: "development",
    scope: "deploy.manage",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const added = await attempt("add the domain", () =>
            surface.addDomain(deployCaller(caller), input.service, {
                hostname: input.hostname,
                targetPort: input.targetPort,
                certificate: input.certificate
            })
        );
        return { text: `${added.hostname} is attached.`, structured: added };
    }
};

const restartTool: McpTool<z.infer<typeof serviceInput>> = {
    name: "deploy_restart",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Restart a service",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Restart a service's running container from its current configuration. Does not rebuild it.",
    input: serviceInput,
    category: "development",
    scope: "deploy.manage",
    readOnly: false,
    async run(input, caller) {
        await attempt("restart the service", () =>
            surface.power(deployCaller(caller), input.service, "restart")
        );
        return { text: "Restarted.", structured: { restarted: true } };
    }
};

const rollbackInput = z.object({
    deploymentId: z.string().uuid().describe("The earlier deployment to make current again.")
});

const rollbackTool: McpTool<z.infer<typeof rollbackInput>> = {
    name: "deploy_rollback",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Roll back a service",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Make an earlier deployment of a service its running release again, from its kept image - nothing is rebuilt. Only releases deploy_deployments marks as able to roll back qualify.",
    input: rollbackInput,
    category: "development",
    scope: "deploy.manage",
    readOnly: false,
    async run(input, caller) {
        const { deploymentId } = await attempt("roll back to that deployment", () =>
            surface.rollback(deployCaller(caller), input.deploymentId)
        );
        return {
            text: `Rolling back as deployment ${deploymentId}. Read it with deploy_deployment.`,
            structured: { deploymentId }
        };
    }
};

/** Every Deploy service this caller reaches, by name, for `polaris_search`.
 *  A project token reaches its project only, as `deploy_projects` does. */
export const DEPLOY_SEARCH = defineMcpSearch({
    id: "deploy.services",
    app: "deploy",
    category: "development",
    scope: "deploy.read",
    async search(_query, caller, limit) {
        const projects = await surface.listProjects(deployCaller(caller));
        return projects
            .flatMap((project) =>
                project.environments.flatMap((environment) =>
                    environment.services.map((service) => {
                        const ref = `${project.slug}/${environment.slug}/${service.slug}`;
                        return {
                            id: service.id,
                            name: service.name,
                            kind: "deploy service",
                            where: `${project.name} / ${environment.name}`,
                            keywords: [ref, service.status],
                            next: [
                                { tool: "deploy_service", args: { service: ref } },
                                { tool: "deploy_deployments", args: { service: ref } },
                                { tool: "deploy_start", args: { service: ref } },
                                { tool: "deploy_restart", args: { service: ref } }
                            ]
                        };
                    })
                )
            )
            .slice(0, limit);
    }
});

export const DEPLOY_TOOLS: readonly McpTool<never>[] = [
    projectsTool,
    serviceTool,
    deploymentsTool,
    deploymentTool,
    logsTool,
    variablesTool,
    envListTool,
    domainsTool,
    startTool,
    setVariableTool,
    envSetTool,
    envDeleteTool,
    addDomainTool,
    restartTool,
    rollbackTool
] as unknown as readonly McpTool<never>[];
