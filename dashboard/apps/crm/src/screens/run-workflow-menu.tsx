"use client";

/**
 * A record's "run workflow" menu: the workflows of its kind that run by hand,
 * read when the menu opens, and the result of a run as a toast.
 */

import { useState } from "react";
import { useCrmT } from "./i18n";
import { Play } from "lucide-react";
import { messageOf, unwrap } from "./call";
import * as actions from "../actions/workflows";
import type { CrmObject } from "../model/objects";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    useToast
} from "@polaris/ui";

export interface RunWorkflowMenuProps {
    readonly object: CrmObject;
    readonly id: string;
    /** A run finished: the record may have changed. */
    readonly onRan: () => void;
}

export function RunWorkflowMenu({ object, id, onRan }: RunWorkflowMenuProps) {
    const t = useCrmT();
    const toast = useToast();
    const [list, setList] = useState<{ id: string; name: string }[] | null>(null);
    const [busy, setBusy] = useState(false);

    const load = () => {
        unwrap(() => actions.listManualWorkflowsAction({ object }), t("errors.loadFailed"))
            .then((answer) => setList(answer.workflows))
            .catch((caught) => {
                setList([]);
                toast.show({ title: t("errors.loadFailed"), body: messageOf(caught) });
            });
    };

    const run = async (workflow: { id: string; name: string }) => {
        setBusy(true);
        try {
            const answer = await unwrap(
                () => actions.runManualWorkflowAction({ object, id, workflowId: workflow.id }),
                t("errors.generic")
            );
            toast.show(
                answer.error
                    ? {
                          title: t("workflows.runFailed", { name: workflow.name }),
                          body: answer.error
                      }
                    : { title: t("workflows.ran", { name: workflow.name }) }
            );
            onRan();
        } catch (caught) {
            toast.show({
                title: t("workflows.runFailed", { name: workflow.name }),
                body: messageOf(caught)
            });
        } finally {
            setBusy(false);
        }
    };

    return (
        <DropdownMenu onOpenChange={(open) => open && load()}>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={t("workflows.run")}
                    title={t("workflows.run")}
                >
                    <Play className="size-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-72">
                {list === null ? (
                    <DropdownMenuItem disabled>{t("list.loading")}</DropdownMenuItem>
                ) : list.length === 0 ? (
                    <DropdownMenuItem disabled>{t("workflows.noManual")}</DropdownMenuItem>
                ) : (
                    list.map((workflow) => (
                        <DropdownMenuItem key={workflow.id} onSelect={() => void run(workflow)}>
                            <span className="truncate" title={workflow.name}>
                                {workflow.name}
                            </span>
                        </DropdownMenuItem>
                    ))
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
