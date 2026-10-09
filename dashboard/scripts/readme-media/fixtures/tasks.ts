/** A product team's space: one list mid-sprint, worked on by everybody in it. */

import { TEAM, VIEWER, ago, id } from "./people";
import type { TaskPriority } from "@polaris/core";
import type { SceneContext } from "../runtime/scene";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import type { TaskDetail } from "@/lib/tasks/task-service";
import type { SpaceTreeView, StatusView, TagView } from "@/lib/tasks/space-service";

export const TASK_SPACE_ID = id("task-space", 1);
export const TASK_LIST_ID = id("task-list", 1);

const STATUS = {
    todo: id("status", 1),
    doing: id("status", 2),
    review: id("status", 3),
    done: id("status", 4)
};

function statuses(ctx: SceneContext): StatusView[] {
    const say = ctx.say;
    return [
        {
            id: STATUS.todo,
            name: say("To do", "Por hacer"),
            type: "open",
            color: "#94a3b8",
            order: 0
        },
        {
            id: STATUS.doing,
            name: say("In progress", "En curso"),
            type: "active",
            color: "#3b82f6",
            order: 1
        },
        {
            id: STATUS.review,
            name: say("In review", "En revisión"),
            type: "active",
            color: "#a855f7",
            order: 2
        },
        { id: STATUS.done, name: say("Done", "Hecho"), type: "done", color: "#22c55e", order: 3 }
    ];
}

function tags(ctx: SceneContext): TagView[] {
    const say = ctx.say;
    return [
        { id: id("tag", 1), name: say("frontend", "frontend"), color: "#0ea5e9" },
        { id: id("tag", 2), name: say("backend", "backend"), color: "#f97316" },
        { id: id("tag", 3), name: say("design", "diseño"), color: "#ec4899" },
        { id: id("tag", 4), name: say("bug", "error"), color: "#ef4444" }
    ];
}

/** A day from the scene's moment, as the date-only string a due date is. */
function day(ctx: SceneContext, offset: number): string {
    return new Date(ctx.now + offset * 86_400_000).toISOString().slice(0, 10);
}

export function listName(ctx: SceneContext): string {
    return ctx.say("March release", "Versión de marzo");
}

export function spaceName(ctx: SceneContext): string {
    return ctx.say("Product", "Producto");
}

interface Draft {
    readonly name: [string, string];
    readonly status: keyof typeof STATUS;
    readonly priority: TaskPriority;
    readonly people: readonly { id: string; name: string }[];
    readonly tags: readonly number[];
    readonly due?: number;
    readonly subtasks?: number;
    readonly comments?: number;
    readonly points?: number;
    readonly description?: [string, string];
}

const DRAFTS: readonly Draft[] = [
    {
        name: ["Onboarding: welcome screens", "Bienvenida: pantallas iniciales"],
        status: "doing",
        priority: "high",
        people: [TEAM.lena],
        tags: [3, 1],
        due: 1,
        subtasks: 4,
        comments: 6,
        points: 5,
        description: [
            "Three screens that take a new account from sign-up to its first project. Copy is final; the illustrations are in the design doc.",
            "Tres pantallas que llevan una cuenta nueva del registro a su primer proyecto. El texto es definitivo; las ilustraciones están en el documento de diseño."
        ]
    },
    {
        name: ["Release notes for 2.4", "Notas de la versión 2.4"],
        status: "todo",
        priority: "normal",
        people: [TEAM.kenji],
        tags: [],
        due: 2,
        points: 1
    },
    {
        name: ["Rate limit the public API", "Limitar la API pública"],
        status: "review",
        priority: "urgent",
        people: [TEAM.sam],
        tags: [2],
        due: 0,
        comments: 3,
        points: 3
    },
    {
        name: ["Search results show archived projects", "La búsqueda muestra proyectos archivados"],
        status: "doing",
        priority: "high",
        people: [VIEWER],
        tags: [4, 2],
        due: 1,
        comments: 2,
        points: 2
    },
    {
        name: ["Dark mode for the billing page", "Modo oscuro en la facturación"],
        status: "todo",
        priority: "low",
        people: [TEAM.priya],
        tags: [1],
        points: 2
    },
    {
        name: ["Migrate exports to background jobs", "Exportaciones como tareas en segundo plano"],
        status: "todo",
        priority: "normal",
        people: [TEAM.sam, VIEWER],
        tags: [2],
        due: 6,
        subtasks: 3,
        points: 5
    },
    {
        name: ["Pricing page copy", "Textos de la página de precios"],
        status: "review",
        priority: "normal",
        people: [TEAM.ana],
        tags: [],
        comments: 4,
        points: 1
    },
    {
        name: ["Fix flaky checkout test", "Arreglar la prueba inestable del pago"],
        status: "done",
        priority: "high",
        people: [TEAM.kenji],
        tags: [4],
        points: 1
    },
    {
        name: ["Invite teammates from the project page", "Invitar al equipo desde el proyecto"],
        status: "done",
        priority: "normal",
        people: [TEAM.ana, TEAM.lena],
        tags: [1],
        comments: 5,
        points: 3
    },
    {
        name: ["Audit log retention setting", "Retención del registro de auditoría"],
        status: "todo",
        priority: "none",
        people: [],
        tags: [2],
        points: 2
    }
];

export function taskRows(ctx: SceneContext): TaskRow[] {
    const all = statuses(ctx);
    const allTags = tags(ctx);
    return DRAFTS.map((draft, index) => {
        const status = all.find((one) => one.id === STATUS[draft.status])!;
        const done = status.type === "done";
        return {
            id: id("task", index + 1),
            reference: `PRD-${112 + index}`,
            name: ctx.say(...draft.name),
            description: draft.description ? ctx.say(...draft.description) : "",
            spaceId: TASK_SPACE_ID,
            spaceName: spaceName(ctx),
            listId: TASK_LIST_ID,
            listName: listName(ctx),
            folderName: null,
            parentId: null,
            statusId: status.id,
            statusName: status.name,
            statusColor: status.color,
            statusType: status.type,
            priority: draft.priority,
            assignees: draft.people.map((one) => ({ id: one.id, name: one.name })),
            tags: draft.tags.map((n) => allTags[n - 1]!),
            createdById: VIEWER.id,
            startDate: null,
            dueDate: draft.due === undefined ? null : day(ctx, draft.due),
            timed: false,
            timeEstimate: null,
            points: draft.points ?? null,
            milestone: false,
            archived: false,
            order: index,
            sprintId: null,
            completedAt: done ? ago(ctx.now, 60 * 20) : null,
            createdAt: ago(ctx.now, 60 * 24 * (9 - index)),
            updatedAt: ago(ctx.now, 30 + index * 11),
            subtaskCount: draft.subtasks ?? 0,
            commentCount: draft.comments ?? 0,
            trackedSeconds: 0,
            blocked: false,
            blockedUntil: null,
            blockedNote: "",
            recurring: false,
            customValues: {}
        };
    });
}

export function taskContext(ctx: SceneContext): SpaceContext {
    return {
        spaceId: TASK_SPACE_ID,
        statuses: statuses(ctx),
        tags: tags(ctx),
        fields: [],
        people: [VIEWER, ...Object.values(TEAM)].map((one) => ({ id: one.id, name: one.name })),
        canEdit: true,
        canModerate: true,
        currentUserId: VIEWER.id,
        siblings: taskRows(ctx)
    };
}

export function spaceTree(ctx: SceneContext): SpaceTreeView[] {
    const say = ctx.say;
    const list = (
        n: number,
        name: string,
        open: number,
        total: number,
        folderId: string | null = null
    ) => ({
        id: n === 1 ? TASK_LIST_ID : id("task-list", n),
        name,
        folderId,
        color: null,
        openCount: open,
        totalCount: total,
        empty: false
    });
    return [
        {
            id: TASK_SPACE_ID,
            name: spaceName(ctx),
            prefix: "PRD",
            color: "#6366f1",
            visibility: "private",
            role: "owner",
            folders: [
                {
                    id: id("task-folder", 1),
                    name: say("Roadmap", "Hoja de ruta"),
                    parentId: null,
                    role: "owner",
                    lists: [
                        list(3, say("Q2 ideas", "Ideas T2"), 14, 14, id("task-folder", 1)),
                        list(4, say("Research", "Investigación"), 5, 9, id("task-folder", 1))
                    ]
                }
            ],
            lists: [list(1, listName(ctx), 7, 10), list(2, say("Bugs", "Errores"), 4, 31)],
            partial: false
        },
        {
            id: id("task-space", 2),
            name: say("Marketing", "Marketing"),
            prefix: "MKT",
            color: "#f59e0b",
            visibility: "private",
            role: "member",
            folders: [],
            lists: [
                {
                    id: id("task-list", 5),
                    name: say("Launch plan", "Plan de lanzamiento"),
                    folderId: null,
                    color: null,
                    openCount: 6,
                    totalCount: 8,
                    empty: false
                }
            ],
            partial: false
        }
    ];
}

/** The open task, as its panel reads it: subtasks, a checklist, a short thread. */
export function taskDetail(ctx: SceneContext): TaskDetail {
    const say = ctx.say;
    const rows = taskRows(ctx);
    const task = rows[0]!;
    const statusOf = (n: number) => rows.find((row) => row.statusId === Object.values(STATUS)[n])!;
    const sub = (
        n: number,
        name: string,
        done: boolean,
        who: { id: string; name: string }
    ): TaskRow => {
        const like = statusOf(done ? 3 : n === 1 ? 1 : 0);
        return {
            ...task,
            id: id("subtask", n),
            reference: `PRD-${130 + n}`,
            name,
            description: "",
            parentId: task.id,
            statusId: like.statusId,
            statusName: like.statusName,
            statusColor: like.statusColor,
            statusType: like.statusType,
            assignees: [{ id: who.id, name: who.name }],
            tags: [],
            subtaskCount: 0,
            commentCount: 0,
            points: null,
            completedAt: done ? ago(ctx.now, 60 * 5) : null
        };
    };
    return {
        task,
        subtasks: [
            sub(
                1,
                say("Final copy in the three screens", "Texto final en las tres pantallas"),
                true,
                TEAM.ana
            ),
            sub(
                2,
                say(
                    "Illustrations exported for dark mode",
                    "Ilustraciones exportadas para modo oscuro"
                ),
                true,
                TEAM.lena
            ),
            sub(
                3,
                say(
                    "First project created from the last screen",
                    "Primer proyecto desde la última pantalla"
                ),
                false,
                VIEWER
            ),
            sub(4, say("Track where people drop off", "Medir dónde se abandona"), false, TEAM.sam)
        ],
        watchers: [TEAM.ana, TEAM.kenji].map((one) => ({ id: one.id, name: one.name })),
        checklists: [
            {
                id: id("checklist", 1),
                name: say("Before release", "Antes de publicar"),
                items: [
                    {
                        id: id("check", 1),
                        name: say("Reviewed on a phone", "Revisado en un móvil"),
                        done: true,
                        assigneeId: null
                    },
                    {
                        id: id("check", 2),
                        name: say("Spanish copy checked", "Texto en español revisado"),
                        done: true,
                        assigneeId: null
                    },
                    {
                        id: id("check", 3),
                        name: say("Screen reader pass", "Prueba con lector de pantalla"),
                        done: false,
                        assigneeId: TEAM.lena.id
                    }
                ]
            }
        ],
        comments: [
            {
                id: id("comment", 1),
                body: say(
                    "Pushed the second screen, the progress dots now match the design.",
                    "Subida la segunda pantalla, los puntos de progreso ya coinciden con el diseño."
                ),
                parentId: null,
                assignedToId: null,
                resolvedAt: null,
                createdAt: ago(ctx.now, 95),
                author: { id: TEAM.lena.id, name: TEAM.lena.name },
                files: []
            },
            {
                id: id("comment", 2),
                body: say(
                    "Looks right on my phone. Can we skip the third screen for invited accounts?",
                    "En mi móvil se ve bien. ¿Saltamos la tercera pantalla para cuentas invitadas?"
                ),
                parentId: null,
                assignedToId: null,
                resolvedAt: null,
                createdAt: ago(ctx.now, 41),
                author: { id: VIEWER.id, name: VIEWER.name },
                files: []
            }
        ],
        dependencies: [],
        activity: [],
        timeEntries: [],
        attachments: [],
        commits: [],
        recurrence: null,
        parent: null
    };
}
