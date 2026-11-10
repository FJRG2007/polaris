/**
 * Automations, as tools an agent can call - and so Polar's way to build and run
 * them for somebody.
 *
 * Every call goes through the module the Automations screens use
 * (`lib/automations/service`), as the caller's own account: a shelf they cannot
 * edit is one their assistant cannot edit either, an organization's
 * automations need the same organization permission they need in the screen,
 * and one somebody shared with them to look at is never changed.
 *
 * A graph the model writes is held to what the editor holds one to: the core
 * graph schema, then the node registry's problems (each node's config parsed
 * by its own type's schema, the ports a node really has, no cycle). One that
 * fails is refused with the problems named, so the model can fix it, and
 * nothing is saved. New nodes are placed on the canvas the way a pasted one is.
 *
 * Deliberately not offered: deleting an automation, secrets, and the local
 * network switch. Each is a click in the screen and none is something an
 * assistant should be doing on a guess.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { zodSchema } from "ai";
import type { RunActor } from "@/lib/automations/types";
import { moreLine, pageFields, pageOf } from "./paging";
import { McpRefusal, type McpCaller, type McpTool, type McpToolTarget } from "../protocol";

/** The automations services, loaded when a tool runs rather than when the catalogue does. */
async function services() {
    const [service, registry, scope, i18n] = await Promise.all([
        import("@/lib/automations/service"),
        import("@/lib/automations/node-registry"),
        import("@/lib/workspace-scope"),
        import("@/lib/i18n/translate")
    ]);
    return { service, registry, scope, i18n };
}

function actorFor(caller: McpCaller): RunActor {
    return { id: caller.userId, isAdmin: caller.isAdmin };
}

/**
 * Run an automations operation, turning the service's refusal into the
 * sentence the screen shows for it. Those name nothing internal.
 */
async function attempt<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        const { service, i18n } = await services();
        if (caught instanceof service.AutomationAccessError)
            throw new McpRefusal(i18n.translate("en-US", `automations.errors.${caught.code}`));
        throw caught;
    }
}

/** The address an automation opens on, for the model to hand on. */
export function automationHref(id: string): string {
    return `/automations/${id}`;
}

const automationId = z
    .string()
    .uuid()
    .describe(
        "The automation's id, as automations_list returned it, or the id of the \"automation\" record on the person's screen."
    );

// ---------------------------------------------------------------------------
// Graph input
// ---------------------------------------------------------------------------

const nodeInput = z.object({
    id: core.graphNodeSchema.shape.id.describe(
        "A short id of your choosing, unique in this automation: letters, digits, - and _."
    ),
    type: core.graphNodeSchema.shape.type.describe(
        "The node type, as automations_node_types lists it, such as core.manual or core.notify."
    ),
    config: z
        .unknown()
        .default({})
        .describe("The node's settings, shaped as automations_node_types gives for its type."),
    alias: z.string().trim().max(80).optional().describe("A name for this step on the canvas."),
    note: z.string().trim().max(250).optional().describe("A short note shown under the step."),
    onError: z
        .enum(["stop", "continue", "port"])
        .optional()
        .describe('What a failure does: stop the run, carry on, or leave by the "error" port.')
});
type NodeInput = z.infer<typeof nodeInput>;

const edgeInput = z.object({
    from: z.string().min(1).max(64).describe("The id of the node the connection leaves."),
    port: z
        .string()
        .min(1)
        .max(40)
        .default("next")
        .describe(
            'The port it leaves by: "next" for most steps, "then"/"else" for a condition, as automations_node_types lists.'
        ),
    to: z.string().min(1).max(64).describe("The id of the node it leads to.")
});
type EdgeInput = z.infer<typeof edgeInput>;

const nodesField = z
    .array(nodeInput)
    .max(core.AUTOMATION_LIMITS.nodes)
    .default([])
    .describe("Nodes: one trigger at least, then the steps it starts.");
const edgesField = z
    .array(edgeInput)
    .max(core.AUTOMATION_LIMITS.edges)
    .default([])
    .describe("Connections between the nodes, in the order a run follows them.");

function edgeOf(edge: EdgeInput): core.GraphEdge {
    return { from: { node: edge.from, port: edge.port }, to: { node: edge.to } };
}

function graphNodeOf(node: NodeInput, kept?: core.GraphNode): core.GraphNode {
    return {
        ...kept,
        id: node.id,
        type: node.type,
        typeVersion: kept?.typeVersion ?? 1,
        config: node.config ?? {},
        ...(node.alias !== undefined ? { alias: node.alias } : {}),
        ...(node.note !== undefined ? { note: node.note } : {}),
        ...(node.onError !== undefined ? { onError: node.onError } : {}),
        // A node whose type changed is placed again; one only reconfigured stays where it was.
        ...(kept && kept.type === node.type ? {} : { position: undefined, pinned: undefined })
    };
}

/** A problem as the model reads it: what is wrong and on which node. */
export function problemLine(problem: core.GraphProblem): string {
    if (!("node" in problem)) return "The automation has no trigger. Add one, such as core.manual.";
    const where = `node ${problem.node}`;
    switch (problem.code) {
        case "badConfig":
            return `${where}: its config does not fit its type (${problem.issue}). Read automations_node_types for the shape.`;
        case "unknownPort":
            return `${where}: has no port "${problem.port}".`;
        case "unknownEdgeNode":
            return `${where}: a connection names a node that is not in the automation.`;
        case "intoTrigger":
            return `${where}: is a trigger, and nothing may lead into a trigger.`;
        case "duplicateNode":
            return `${where}: two nodes share this id.`;
        case "cycle":
            return `${where}: is part of a loop of connections. Use core.forEach or core.repeat to repeat steps.`;
        default:
            return `${where}: ${problem.code}.`;
    }
}

/**
 * The graph checked as the editor checks it. Returns the parsed graph, placed
 * on the canvas, or throws a refusal naming every problem. `strict` refuses a
 * bad config anywhere; otherwise only on the nodes this call wrote, since a
 * person's own half-finished step is theirs to finish.
 */
export async function checkedGraph(
    graph: unknown,
    options: { forPublish: boolean; wrote: ReadonlySet<string> | "all" }
): Promise<core.AutomationGraph> {
    const parsed = core.automationGraphSchema.safeParse(graph);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new McpRefusal(
            `The automation is not valid: ${issue?.path.join(".") || "graph"} - ${issue?.message ?? "invalid"}.`
        );
    }
    const { registry } = await services();
    const problems = (
        await registry.graphProblems(parsed.data, { forPublish: options.forPublish })
    ).filter(
        (problem) =>
            problem.code !== "badConfig" ||
            options.wrote === "all" ||
            options.wrote.has(problem.node)
    );
    if (problems.length > 0)
        throw new McpRefusal(
            `Nothing was saved. Fix these and call again:\n${problems.map(problemLine).join("\n")}`
        );
    return core.placeNew(parsed.data);
}

/** A graph in a few lines the model can read: each node with its config, each connection. */
export function graphSummary(graph: core.AutomationGraph): string {
    const nodes = graph.nodes.map((node) => {
        const name = node.alias ? ` "${node.alias}"` : "";
        const off = node.enabled === false ? " (switched off)" : "";
        return `- ${node.id}${name}: ${node.type}${off} ${JSON.stringify(node.config ?? {})}`;
    });
    const edges = graph.edges.map(
        (edge) => `- ${edge.from.node} --${edge.from.port}--> ${edge.to.node}`
    );
    return [
        `Nodes (${graph.nodes.length}):`,
        ...(nodes.length ? nodes : ["- none"]),
        `Connections (${graph.edges.length}):`,
        ...(edges.length ? edges : ["- none"])
    ].join("\n");
}

/** The name an approval card shows for the automation a call changes. */
async function automationTarget(
    input: { automation: string },
    caller: McpCaller,
    action: string
): Promise<McpToolTarget | null> {
    const { service } = await services();
    const row = await service.load(actorFor(caller), input.automation, false);
    return { id: row.id, name: row.name, action };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const listInput = z.object({
    query: z
        .string()
        .trim()
        .max(200)
        .default("")
        .describe("Words from the automation's name or description. Empty lists every one."),
    organization: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe(
            "An organization's id for its automations, null for the person's own. Left out: the workspace they have open."
        ),
    ...pageFields
});

const listTool: McpTool<z.infer<typeof listInput>> = {
    name: "automations_list",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List automations",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "List the automations this account can see in a workspace: name, whether it is published and on, and its last run. Use automations_get for the steps.",
    input: listInput,
    category: "development",
    scope: "automations.use",
    readOnly: true,
    async run(input, caller) {
        const { service, scope } = await services();
        const actor = actorFor(caller);
        const orgId =
            input.organization === undefined
                ? await scope.scopeOrgIdFor(caller.userId)
                : input.organization;
        const shelf = { orgId, userId: orgId ? null : caller.userId };
        const { rows, canEdit } = await attempt(() => service.listAutomations(actor, shelf));
        const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
        const matching = words.length
            ? rows.filter((row) => {
                  const text = `${row.name} ${row.description}`.toLowerCase();
                  return words.every((word) => text.includes(word));
              })
            : rows;
        const page = pageOf(matching, input.offset, input.limit);
        const lines = page.items.map((row) => {
            const state = !row.published ? "draft" : row.enabled ? "on" : "off";
            const last = row.lastRunAt ? `, last run ${row.lastRunAt} ${row.lastStatus ?? ""}` : "";
            return `- ${row.name} (${row.id}): ${state}${last}${row.shared ? ", shared with you to look at" : ""}`;
        });
        return {
            text: lines.length
                ? `${lines.join("\n")}${moreLine(page)}${canEdit ? "" : "\nYou can look at these but not change them."}`
                : "No automations here.",
            structured: {
                automations: page.items.map((row) => ({
                    id: row.id,
                    name: row.name,
                    published: row.published,
                    enabled: row.enabled,
                    lastRunAt: row.lastRunAt,
                    lastStatus: row.lastStatus,
                    href: automationHref(row.id)
                })),
                canEdit,
                nextOffset: page.nextOffset,
                total: page.total
            }
        };
    }
};

const getInput = z.object({ automation: automationId });

const getTool: McpTool<z.infer<typeof getInput>> = {
    name: "automations_get",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Read an automation",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Read one automation: its state and its draft's nodes (id, type, config) and connections. Read it before changing the draft.",
    input: getInput,
    category: "development",
    scope: "automations.use",
    readOnly: true,
    async run(input, caller) {
        const { service } = await services();
        const found = await attempt(() =>
            service.getAutomation(actorFor(caller), input.automation)
        );
        const state = !found.published ? "a draft, never published" : found.enabled ? "on" : "off";
        const differs =
            found.publishedVersion !== null &&
            core.draftDiffers(found.draft, found.publishedVersion.graph);
        return {
            text: [
                `${found.name} (${found.id}) is ${state}${differs ? ", with draft changes not published yet" : ""}.`,
                found.description ? `Description: ${found.description}` : "",
                found.canEdit ? "" : "You can look at it but not change it.",
                graphSummary(found.draft)
            ]
                .filter(Boolean)
                .join("\n"),
            structured: {
                id: found.id,
                name: found.name,
                published: found.published,
                enabled: found.enabled,
                canEdit: found.canEdit,
                href: automationHref(found.id),
                draft: { nodes: found.draft.nodes, edges: found.draft.edges }
            }
        };
    }
};

const typesInput = z.object({
    kind: z
        .enum(["all", "trigger", "step"])
        .default("all")
        .describe("Only triggers, only steps, or both."),
    types: z
        .array(z.string().min(1).max(100))
        .max(40)
        .default([])
        .describe("Only these node types, by name. Empty: every one of the kind.")
});

/** One node type as the model is told about it. */
export interface NodeTypeLine {
    readonly type: string;
    readonly role: string;
    readonly ports: readonly string[];
    readonly hint: string;
    readonly config: unknown;
}

/** Every node type a graph may use here, with its ports and config shape. */
export async function nodeTypeLines(): Promise<NodeTypeLine[]> {
    const { i18n } = await services();
    const { appAutomationNodes } = await import("@/lib/app-extensions/registry");
    const schemaOf = async (schema: z.ZodTypeAny): Promise<unknown> => {
        try {
            const { $schema: _, ...shape } = (await zodSchema(schema as never).jsonSchema) as {
                $schema?: unknown;
            };
            return shape;
        } catch {
            return "see the node's settings in the editor";
        }
    };
    const lines: NodeTypeLine[] = await Promise.all(
        core.CORE_NODE_TYPES.map(async (type) => ({
            type,
            role: core.CORE_NODE_META[type].role,
            ports: core.nodePorts(type),
            hint: i18n.translate("en-US", `automations.nodeHints.${type.slice(5)}` as never),
            config: await schemaOf(core.CORE_NODE_CONFIGS[type] as z.ZodTypeAny)
        }))
    );
    for (const node of await appAutomationNodes().catch(() => []))
        lines.push({
            type: node.type,
            role: node.meta.role,
            ports: core.nodePorts(node.type),
            hint: "",
            config: await schemaOf(node.config as z.ZodTypeAny)
        });
    return lines;
}

const typesTool: McpTool<z.infer<typeof typesInput>> = {
    name: "automations_node_types",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Automation node types",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "The node types an automation can use here: what each does, its output ports, and the JSON shape of its config. Read it before building or changing a graph.",
    input: typesInput,
    category: "development",
    scope: "automations.use",
    readOnly: true,
    async run(input) {
        const all = await nodeTypeLines();
        const wanted = all.filter((line) =>
            input.types.length > 0 && !input.types.includes(line.type)
                ? false
                : input.kind === "all"
                  ? true
                  : input.kind === "trigger"
                    ? line.role === "trigger"
                    : line.role !== "trigger"
        );
        const text = [
            "Rules: a graph needs a trigger; nothing leads into a trigger; connect steps by their ports; reference earlier output as {{trigger.*}} or {{steps.<nodeId>.*}}.",
            ...wanted.map(
                (line) =>
                    `- ${line.type} (${line.role}; ports: ${line.ports.join(", ") || "none"})${line.hint ? ` - ${line.hint}` : ""}\n  config: ${JSON.stringify(line.config)}`
            )
        ].join("\n");
        return { text, structured: { types: wanted } };
    }
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const createInput = z.object({
    name: z
        .string()
        .trim()
        .min(1)
        .max(core.AUTOMATION_LIMITS.nameLength)
        .describe("What the automation is called, in the person's language."),
    description: z
        .string()
        .trim()
        .max(core.AUTOMATION_LIMITS.descriptionLength)
        .default("")
        .describe("One line on what it does."),
    organization: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe(
            "An organization's id to create it there, null for the person's own. Left out: the workspace they have open."
        ),
    timeZone: z
        .string()
        .min(1)
        .max(64)
        .default("UTC")
        .describe("The IANA time zone its schedules run in, such as Europe/Madrid."),
    nodes: nodesField,
    edges: edgesField
});

const createTool: McpTool<z.infer<typeof createInput>> = {
    name: "automations_create",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Create an automation",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Create an automation as a draft from a whole graph: a trigger and the steps it starts. It is not published or switched on; the person reviews it on its screen. Read automations_node_types first.",
    input: createInput,
    category: "development",
    scope: "automations.use",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const { service, scope } = await services();
        const actor = actorFor(caller);
        const graph = await checkedGraph(
            {
                ...core.emptyGraph(input.timeZone),
                nodes: input.nodes.map((node) => graphNodeOf(node)),
                edges: input.edges.map(edgeOf)
            },
            { forPublish: true, wrote: "all" }
        );
        const orgId =
            input.organization === undefined
                ? await scope.scopeOrgIdFor(caller.userId)
                : input.organization;
        const id = await attempt(() =>
            service.createAutomation(
                actor,
                {
                    name: core.normalizeAutomationName(input.name),
                    description: input.description,
                    orgId
                },
                input.timeZone
            )
        );
        try {
            await attempt(() => service.saveDraft(actor, id, graph));
        } catch (caught) {
            // An automation left behind with only the starter trigger is not what was asked for.
            await service.deleteAutomation(actor, id).catch(() => undefined);
            throw caught;
        }
        return {
            text: `Created "${input.name}" as a draft with ${graph.nodes.length} nodes. It opens at ${automationHref(id)}; publish it there, or with automations_publish once the person agrees.`,
            structured: { automationId: id, href: automationHref(id) }
        };
    }
};

const updateInput = z.object({
    automation: automationId,
    nodes: nodesField.describe(
        "Nodes to add, or to replace when one with the same id is already there."
    ),
    edges: edgesField.describe("Connections to add."),
    removeNodes: z
        .array(z.string().min(1).max(64))
        .max(core.AUTOMATION_LIMITS.nodes)
        .default([])
        .describe("Ids of nodes to remove, with every connection touching them."),
    removeEdges: z
        .array(edgeInput)
        .max(core.AUTOMATION_LIMITS.edges)
        .default([])
        .describe(
            "Connections to remove. To put a step between two others, remove their connection and add two."
        )
});

/** The draft with one call's changes made, and the ids of the nodes it wrote. Pure, for the tests. */
export function editedGraph(
    draft: core.AutomationGraph,
    change: Pick<z.infer<typeof updateInput>, "nodes" | "edges" | "removeNodes" | "removeEdges">
): { graph: core.AutomationGraph; wrote: Set<string> } {
    const removed = new Set(change.removeNodes);
    const cut = new Set(change.removeEdges.map((edge) => core.edgeKey(edgeOf(edge))));
    const byId = new Map(draft.nodes.map((node) => [node.id, node]));
    const wrote = new Set(change.nodes.map((node) => node.id));
    const nodes = draft.nodes
        .filter((node) => !removed.has(node.id))
        .map((node) => {
            const next = change.nodes.find((entry) => entry.id === node.id);
            return next ? graphNodeOf(next, node) : node;
        });
    for (const node of change.nodes)
        if (!byId.has(node.id) && !removed.has(node.id)) nodes.push(graphNodeOf(node));
    const kept = draft.edges.filter(
        (edge) =>
            !removed.has(edge.from.node) &&
            !removed.has(edge.to.node) &&
            !cut.has(core.edgeKey(edge))
    );
    const added = change.edges
        .map(edgeOf)
        .filter((edge) => !kept.some((other) => core.edgeKey(other) === core.edgeKey(edge)));
    const entry =
        draft.finally.entry && removed.has(draft.finally.entry) ? null : draft.finally.entry;
    return {
        graph: {
            ...draft,
            nodes,
            edges: [...kept, ...added],
            finally: { ...draft.finally, entry }
        },
        wrote
    };
}

const updateTool: McpTool<z.infer<typeof updateInput>> = {
    name: "automations_update",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Change an automation's draft",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Change an automation's draft: add or replace nodes, add or remove connections, remove nodes. The published version keeps running until it is published again. Read automations_get first.",
    input: updateInput,
    category: "development",
    scope: "automations.use",
    readOnly: false,
    target: (input, caller) => automationTarget(input, caller, "change"),
    async run(input, caller) {
        const { service } = await services();
        const actor = actorFor(caller);
        const found = await attempt(() => service.getAutomation(actor, input.automation));
        if (!found.canEdit)
            throw new McpRefusal("You can look at this automation but not change it.");
        const { graph, wrote } = editedGraph(found.draft, input);
        const checked = await checkedGraph(graph, { forPublish: false, wrote });
        await attempt(() => service.saveDraft(actor, input.automation, checked));
        return {
            text: `Saved the draft of "${found.name}": ${checked.nodes.length} nodes, ${checked.edges.length} connections. ${found.published ? "Publish it for the change to run." : "It is still a draft."}`,
            structured: { automationId: found.id, href: automationHref(found.id) }
        };
    }
};

const publishInput = z.object({ automation: automationId });

const publishTool: McpTool<z.infer<typeof publishInput>> = {
    name: "automations_publish",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Publish an automation",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Publish an automation's draft: it becomes the version that runs, and the automation is switched on. Only when the person asked for it.",
    input: publishInput,
    category: "development",
    scope: "automations.use",
    readOnly: false,
    target: (input, caller) => automationTarget(input, caller, "publish"),
    async run(input, caller) {
        const { service } = await services();
        const problems = await attempt(() =>
            service.publishAutomation(actorFor(caller), input.automation)
        );
        if (problems.length > 0)
            throw new McpRefusal(
                `It was not published. Fix these first:\n${problems.map(problemLine).join("\n")}`
            );
        return {
            text: "Published and switched on.",
            structured: { automationId: input.automation, href: automationHref(input.automation) }
        };
    }
};

const enabledInput = z.object({
    automation: automationId,
    enabled: z.boolean().describe("true switches it on, false pauses it.")
});

const enabledTool: McpTool<z.infer<typeof enabledInput>> = {
    name: "automations_set_enabled",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Switch an automation on or off",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Switch a published automation on, or pause it. A draft that was never published has to be published instead.",
    input: enabledInput,
    category: "development",
    scope: "automations.use",
    readOnly: false,
    idempotent: true,
    target: (input, caller) =>
        automationTarget(input, caller, input.enabled ? "switch on" : "pause"),
    async run(input, caller) {
        const { service } = await services();
        await attempt(() => service.setEnabled(actorFor(caller), input.automation, input.enabled));
        return {
            text: input.enabled ? "Switched on." : "Paused.",
            structured: { automationId: input.automation, href: automationHref(input.automation) }
        };
    }
};

const runInput = z.object({ automation: automationId });

const runTool: McpTool<z.infer<typeof runInput>> = {
    name: "automations_run",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Run an automation now",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Run a published, switched-on automation now, through its Run by hand trigger. Its runs are listed at /automations/runs.",
    input: runInput,
    category: "development",
    scope: "automations.use",
    readOnly: false,
    target: (input, caller) => automationTarget(input, caller, "run"),
    async run(input, caller) {
        const { service } = await services();
        await attempt(() => service.runNow(actorFor(caller), input.automation));
        return {
            text: "Started. It shows on /automations/runs in a moment.",
            structured: { automationId: input.automation, href: "/automations/runs" }
        };
    }
};

export const AUTOMATION_TOOLS = [
    listTool,
    getTool,
    typesTool,
    createTool,
    updateTool,
    publishTool,
    enabledTool,
    runTool
] as unknown as McpTool<never>[];
