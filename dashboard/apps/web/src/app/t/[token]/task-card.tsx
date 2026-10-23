/**
 * One task as somebody outside its list reads it: names only, nothing about
 * where in the instance the work lives. Shown by a public link (/t/<token>) and
 * to a person the task was shared with (`task.task`).
 */

import * as core from "@polaris/core";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";
import { getDisplayFormat } from "@/lib/display-prefs-service";
import type { PublicTaskView } from "@/lib/tasks/share-service";

/** One label and its value, in the same reading order as the task panel. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-start gap-3 py-1.5 text-sm">
            <span className="w-28 shrink-0 truncate text-xs text-muted-foreground" title={label}>
                {label}
            </span>
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

export async function TaskCard({ task }: { task: PublicTaskView }) {
    const [format, t, tp, tt] = await Promise.all([
        getDisplayFormat(),
        getTranslations("publicPages"),
        getTranslations("tasksDetail"),
        getTranslations("tasks")
    ]);
    const showDate = (iso: string | null): string => (iso ? (task.timed ? format.dateTime(iso) : format.date(iso)) : "-");

    return (
        <Card>
            <CardHeader className="flex flex-col gap-1">
                <span className="font-mono text-xs text-muted-foreground">{task.reference}</span>
                <CardTitle className="text-xl">{task.name}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-6">
                <div className="flex flex-col">
                    <Row label={tp("props.status")}>
                        <span className="inline-flex items-center gap-2">
                            <span
                                aria-hidden
                                className="size-2.5 rounded-full"
                                style={{ backgroundColor: task.statusColor }}
                            />
                            <span className={task.finished ? "text-muted-foreground" : undefined}>
                                {task.statusName}
                            </span>
                        </span>
                    </Row>
                    {task.assignees.length > 0 && <Row label={tp("props.assignees")}>{task.assignees.join(", ")}</Row>}
                    {(task.startDate || task.dueDate) && (
                        <Row label={tp("props.dates")}>
                            {showDate(task.startDate)} - {showDate(task.dueDate)}
                        </Row>
                    )}
                    {task.priority !== "none" && (
                        <Row label={tp("props.priority")}>
                            <span style={{ color: core.TASK_PRIORITY_COLORS[task.priority] }}>
                                {tt(`labels.priority.${task.priority}`)}
                            </span>
                        </Row>
                    )}
                    {task.points !== null && <Row label={tp("props.points")}>{task.points}</Row>}
                    {task.tags.length > 0 && (
                        <Row label={tp("props.tags")}>
                            <span className="flex flex-wrap gap-1">
                                {task.tags.map((tag) => (
                                    <Badge
                                        key={tag.name}
                                        className="border-transparent text-[0.6875rem]"
                                        style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
                                    >
                                        {tag.name}
                                    </Badge>
                                ))}
                            </span>
                        </Row>
                    )}
                </div>

                {task.description && (
                    <section className="flex flex-col gap-1">
                        <h2 className="text-sm font-medium">{t("task.description")}</h2>
                        <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">
                            {task.description}
                        </p>
                    </section>
                )}

                {task.subtasks.length > 0 && (
                    <section className="flex flex-col gap-2">
                        <h2 className="text-sm font-medium">{tp("subwork.subtasks")}</h2>
                        <ul className="divide-y divide-border rounded-md border border-border">
                            {task.subtasks.map((subtask, index) => (
                                <li key={index} className="flex items-center gap-2 px-3 py-2 text-sm">
                                    <span
                                        aria-hidden
                                        className="size-2.5 shrink-0 rounded-full"
                                        style={{ backgroundColor: subtask.statusColor }}
                                    />
                                    <span
                                        className={
                                            subtask.finished ? "flex-1 text-muted-foreground" : "flex-1"
                                        }
                                    >
                                        {subtask.name}
                                    </span>
                                    <span className="text-xs text-muted-foreground">{subtask.statusName}</span>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {task.checklists.map((checklist, index) => (
                    <section key={index} className="flex flex-col gap-2">
                        <h2 className="text-sm font-medium">{checklist.name}</h2>
                        <ul className="flex flex-col gap-1 text-sm">
                            {checklist.items.map((item, itemIndex) => (
                                <li
                                    key={itemIndex}
                                    className={item.done ? "text-muted-foreground" : undefined}
                                >
                                    {item.done ? "[x]" : "[ ]"} {item.name}
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}

                {task.comments && task.comments.length > 0 && (
                    <section className="flex flex-col gap-3">
                        <h2 className="text-sm font-medium">{t("task.discussion")}</h2>
                        {task.comments.map((comment, index) => (
                            <div key={index} className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium">{comment.author}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {format.dateTime(comment.createdAt)}
                                    </span>
                                </div>
                                <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">
                                    {comment.body}
                                </p>
                            </div>
                        ))}
                    </section>
                )}

                <p className="text-[0.6875rem] text-muted-foreground">
                    {t("task.lastChanged", { time: format.dateTime(task.updatedAt) })}
                </p>
            </CardBody>
        </Card>
    );
}
