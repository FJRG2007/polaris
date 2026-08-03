/**
 * A task by its public link (/t/<token>).
 *
 * Outside the app shell and outside authentication: whoever holds the link can
 * read the work, and nothing else. A token that names no live share renders the
 * same "not available" page as one that was turned off, so the URL cannot be
 * used to test which tokens exist.
 *
 * Read-only on purpose. Somebody outside Polaris wants to know where their thing
 * is; letting them change it would need an identity Polaris does not have for
 * them, and a comment box open to the internet is a comment box open to the
 * internet.
 */

import Link from "next/link";
import { LogIn } from "lucide-react";
import * as core from "@polaris/core";
import { getSession } from "@/lib/session";
import { getPublicTask } from "@/lib/tasks/share-service";
import { getDisplayFormat } from "@/lib/display-prefs-service";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, PolarisMark } from "@polaris/ui";

export const dynamic = "force-dynamic";

function Shell({ children, signedIn }: { children: React.ReactNode; signedIn: boolean }) {
    return (
        <div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-muted-foreground">
                    <PolarisMark className="size-6" />
                    <span className="text-sm font-medium">Polaris</span>
                </div>
                {!signedIn && (
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/oauth/login">
                            <LogIn className="size-4" />
                            Sign in
                        </Link>
                    </Button>
                )}
            </header>
            {children}
        </div>
    );
}

/** One label and its value, in the same reading order as the task panel. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-start gap-3 py-1.5 text-sm">
            <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

export default async function PublicTaskPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const [task, session, format] = await Promise.all([
        getPublicTask(token),
        getSession(),
        getDisplayFormat()
    ]);
    const signedIn = session?.user !== undefined;

    if (!task) {
        return (
            <Shell signedIn={signedIn}>
                <div className="flex flex-1 flex-col items-center justify-center text-center">
                    <h1 className="text-lg font-semibold">This task is not available</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        The link may have been turned off, or the task may have been deleted.
                    </p>
                </div>
            </Shell>
        );
    }

    const showDate = (iso: string | null): string => (iso ? (task.timed ? format.dateTime(iso) : format.date(iso)) : "-");

    return (
        <Shell signedIn={signedIn}>
            <Card>
                <CardHeader className="flex flex-col gap-1">
                    <span className="font-mono text-xs text-muted-foreground">{task.reference}</span>
                    <CardTitle className="text-xl">{task.name}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-6">
                    <div className="flex flex-col">
                        <Row label="Status">
                            <span className="inline-flex items-center gap-2">
                                <span
                                    aria-hidden
                                    className="size-2.5 rounded-full"
                                    style={{ backgroundColor: task.statusColor }}
                                />
                                <span className={task.finished ? "text-muted-foreground line-through" : undefined}>
                                    {task.statusName}
                                </span>
                            </span>
                        </Row>
                        {task.assignees.length > 0 && <Row label="Assignees">{task.assignees.join(", ")}</Row>}
                        {(task.startDate || task.dueDate) && (
                            <Row label="Dates">
                                {showDate(task.startDate)} - {showDate(task.dueDate)}
                            </Row>
                        )}
                        {task.priority !== "none" && (
                            <Row label="Priority">
                                <span style={{ color: core.TASK_PRIORITY_COLORS[task.priority] }}>
                                    {core.TASK_PRIORITY_LABELS[task.priority]}
                                </span>
                            </Row>
                        )}
                        {task.points !== null && <Row label="Points">{task.points}</Row>}
                        {task.tags.length > 0 && (
                            <Row label="Tags">
                                <span className="flex flex-wrap gap-1">
                                    {task.tags.map((tag) => (
                                        <Badge
                                            key={tag.name}
                                            className="border-transparent text-[11px]"
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
                            <h2 className="text-sm font-medium">Description</h2>
                            <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">
                                {task.description}
                            </p>
                        </section>
                    )}

                    {task.subtasks.length > 0 && (
                        <section className="flex flex-col gap-2">
                            <h2 className="text-sm font-medium">Subtasks</h2>
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
                                                subtask.finished ? "flex-1 text-muted-foreground line-through" : "flex-1"
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
                                        className={item.done ? "text-muted-foreground line-through" : undefined}
                                    >
                                        {item.done ? "[x]" : "[ ]"} {item.name}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}

                    {task.comments && task.comments.length > 0 && (
                        <section className="flex flex-col gap-3">
                            <h2 className="text-sm font-medium">Discussion</h2>
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

                    <p className="text-[11px] text-muted-foreground">
                        Last changed {format.dateTime(task.updatedAt)}. This is a read-only copy.
                    </p>
                </CardBody>
            </Card>
        </Shell>
    );
}
