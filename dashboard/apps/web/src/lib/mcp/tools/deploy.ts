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
 * Deliberately not offered: reading a secret's value. An agent that needs one
 * to do its work should be given it by a person; handing it a tool that prints
 * them puts every secret it can reach one prompt injection away from a public
 * issue comment.
 */

import { z } from "zod";
import * as surface from "@/lib/deploy/api/surface";
import { publicFailure } from "@/lib/deploy/api/refusal";
import { McpRefusal, type McpCaller, type McpTool } from "../protocol";
import { addDomainSchema, serviceRefSchema, setVariableSchema } from "@/lib/deploy/api/schemas";

/** The deploy caller for an MCP call. */
function deployCaller(caller: McpCaller): surface.DeployCaller {
    return {
        userId: caller.userId,
        scopes: caller.scopes,
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
    description:
        "Every Deploy project this key can reach, with each environment's services and what they are doing. Start here to find the name of a service.",
    input: projectsInput,
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
    description:
        "One service: where its code or image comes from, whether it is running, and the hostnames it answers on.",
    input: serviceInput,
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
    description:
        "Deploy a service from its configured source. Returns at once with the deployment id; read its progress with deploy_deployment. Does not change how the service is built.",
    input: serviceInput,
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
    description: "A service's recent deployments, newest first, with status and commit.",
    input: serviceInput,
    scope: "deploy.read",
    readOnly: true,
    async run(input, caller) {
        const deployments = await attempt("list the deployments", () =>
            surface.listDeployments(deployCaller(caller), input.service)
        );
        return {
            text:
                deployments
                    .map(
                        (row) =>
                            `${row.id}  ${row.status}${row.isCurrent ? " (current)" : ""}  ${row.createdAt}  ${
                                row.commitSha?.slice(0, 7) ?? ""
                            } ${row.commitMessage?.split("\n")[0] ?? ""}`.trimEnd()
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
    description:
        "A deployment's status and the end of its build log - what to read when a deploy failed, or to see whether it has finished.",
    input: deploymentInput,
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
    description:
        "What a service's running container has printed recently. For a failed build use deploy_deployment instead - this is the app's own output.",
    input: logsInput,
    scope: "deploy.read",
    readOnly: true,
    async run(input, caller) {
        const { log } = await attempt("read the service's logs", () =>
            surface.runtimeLog(deployCaller(caller), input.service, { tail: input.tail })
        );
        return { text: log || "The container has printed nothing, or is not running.", structured: { log } };
    }
};

const variablesTool: McpTool<z.infer<typeof serviceInput>> = {
    name: "deploy_variables",
    description:
        "A service's environment variables by name. Secret values are never shown - only that the variable exists.",
    input: serviceInput,
    scope: "deploy.read",
    readOnly: true,
    async run(input, caller) {
        const variables = await attempt("list the variables", () =>
            surface.listVariables(deployCaller(caller), { kind: "service", ref: input.service })
        );
        return {
            text:
                variables
                    .map((row) => `${row.key}=${row.isSecret ? "(secret)" : (row.value ?? "")}`)
                    .join("\n") || "No variables.",
            structured: { variables }
        };
    }
};

const setVariableInput = serviceInput.merge(setVariableSchema);

const setVariableTool: McpTool<z.infer<typeof setVariableInput>> = {
    name: "deploy_set_variable",
    description:
        "Set one environment variable on a service (secret by default). A service that is already deployed redeploys to pick it up.",
    input: setVariableInput,
    scope: "deploy.manage",
    readOnly: false,
    async run(input, caller) {
        await attempt("save the variable", () =>
            surface.setVariable(
                deployCaller(caller),
                { kind: "service", ref: input.service },
                { key: input.key, value: input.value, secret: input.secret }
            )
        );
        return {
            text: `${input.key} is saved. The service redeploys to pick it up if it is running.`,
            structured: { key: input.key }
        };
    }
};

const domainsTool: McpTool<z.infer<typeof serviceInput>> = {
    name: "deploy_domains",
    description: "The hostnames a service answers on, with whether each is enabled and reachable.",
    input: serviceInput,
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
    description:
        "Attach a hostname to a service, or its free subdomain when no hostname is given. Does not buy or register a domain.",
    input: addDomainInput,
    scope: "deploy.manage",
    readOnly: false,
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
    description:
        "Restart a service's running container from its current configuration. Does not rebuild it.",
    input: serviceInput,
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
    description:
        "Make an earlier deployment of a service its running release again. Find the id with deploy_deployments.",
    input: rollbackInput,
    scope: "deploy.manage",
    readOnly: false,
    async run(input, caller) {
        const { deploymentId } = await attempt("roll back to that deployment", () =>
            surface.rollback(deployCaller(caller), input.deploymentId)
        );
        return { text: `Rolling back: deployment ${deploymentId}.`, structured: { deploymentId } };
    }
};

export const DEPLOY_TOOLS: readonly McpTool<never>[] = [
    projectsTool,
    serviceTool,
    startTool,
    deploymentsTool,
    deploymentTool,
    logsTool,
    variablesTool,
    setVariableTool,
    domainsTool,
    addDomainTool,
    restartTool,
    rollbackTool
] as unknown as readonly McpTool<never>[];
