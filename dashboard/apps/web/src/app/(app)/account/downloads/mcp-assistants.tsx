/**
 * Downloads > AI assistants (MCP): connecting Claude, ChatGPT, Cursor, VS Code
 * and the rest to this instance.
 *
 * One server URL, and per client the exact thing that client wants: a command,
 * a click-to-install link where the client documents one, or the steps in its
 * own settings. Nothing here carries a credential - every one of these signs in
 * through the consent screen, and is listed under Account > API keys after.
 *
 * Each client is a disclosure rather than a card: six cards of steps is a page
 * nobody finds their own client on, and the name with its mark is what people
 * scan for.
 *
 * Its own component so the page that holds it only places it.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { MCP_PATH } from "@/lib/mcp/oauth/urls";
import * as setup from "@/lib/mcp/client-setup";
import { getTranslations } from "@/lib/i18n/request";
import { CopyButton } from "@/components/copy-button";
import { currentOrigin } from "@/lib/mcp/oauth/origin";
import { Bot, ChevronRight, ExternalLink } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { ClaudeMark, CursorMark, OpenAiMark } from "@/components/model-marks";

/** A value somebody copies: one line or a block, with its copy button. */
function Copyable({ value, label }: { value: string; label: string }) {
    return (
        <div className="flex items-start gap-2 rounded-md border border-border bg-background px-3 py-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs text-foreground">{value}</code>
            <CopyButton value={value} label={label} />
        </div>
    );
}

function Client({
    mark,
    name,
    guide,
    guideLabel,
    children
}: {
    mark: ReactNode;
    name: string;
    guide?: string;
    guideLabel: string;
    children: ReactNode;
}) {
    return (
        <details className="group border-t border-border/60 first:border-t-0">
            <summary className="flex cursor-pointer list-none items-center gap-3 py-3 [&::-webkit-details-marker]:hidden">
                <span className="grid size-6 shrink-0 place-items-center">{mark}</span>
                <span className="min-w-0 flex-1 truncate font-medium" title={name}>{name}</span>
                <ChevronRight
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                    aria-hidden
                />
            </summary>
            <div className="flex flex-col gap-3 pb-4 pl-9">
                {children}
                {guide ? (
                    <a
                        href={guide}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                    >
                        {guideLabel}
                        <ExternalLink className="size-3" aria-hidden />
                    </a>
                ) : null}
            </div>
        </details>
    );
}

export async function McpAssistants() {
    const t = await getTranslations("mcp");
    const url = `${await currentOrigin()}${MCP_PATH}`;
    const guide = t("assistants.official");

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Bot className="size-4" aria-hidden />
                    {t("assistants.title")}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 text-sm">
                <p className="text-muted-foreground">{t("assistants.intro")}</p>

                <div className="flex flex-col gap-1.5">
                    <p className="font-medium">{t("assistants.serverUrl")}</p>
                    <Copyable value={url} label={t("assistants.serverUrl")} />
                </div>

                <div className="flex flex-col">
                    <Client
                        mark={<ClaudeMark className="size-5" />}
                        name={t("assistants.claudeCode.name")}
                        guide={setup.SETUP_GUIDES.claudeCode}
                        guideLabel={guide}
                    >
                        <p>{t("assistants.claudeCode.step1")}</p>
                        <Copyable value={setup.claudeCodeCommand(url)} label={t("assistants.commandLabel")} />
                        <p>
                            {t.rich("assistants.claudeCode.step2", {
                                command: <code key="command" className="text-xs">/mcp</code>
                            })}
                        </p>
                    </Client>

                    <Client
                        mark={<ClaudeMark className="size-5" />}
                        name={t("assistants.claude.name")}
                        guide={setup.SETUP_GUIDES.claude}
                        guideLabel={guide}
                    >
                        <ol className="flex list-decimal flex-col gap-1 pl-4">
                            <li>{t("assistants.claude.step1")}</li>
                            <li>{t("assistants.claude.step2")}</li>
                            <li>{t("assistants.claude.step3")}</li>
                        </ol>
                        <Button asChild variant="outline" size="sm" className="w-fit">
                            <a href={setup.CLAUDE_CONNECTORS_URL} target="_blank" rel="noreferrer noopener">
                                {t("assistants.claude.open")}
                                <ExternalLink className="size-3.5" aria-hidden />
                            </a>
                        </Button>
                        <p className="text-xs text-muted-foreground">{t("assistants.claude.teams")}</p>
                    </Client>

                    <Client
                        mark={<OpenAiMark className="size-5" />}
                        name={t("assistants.chatgpt.name")}
                        guide={setup.SETUP_GUIDES.chatgpt}
                        guideLabel={guide}
                    >
                        <ol className="flex list-decimal flex-col gap-1 pl-4">
                            <li>{t("assistants.chatgpt.step1")}</li>
                            <li>{t("assistants.chatgpt.step2")}</li>
                            <li>{t("assistants.chatgpt.step3")}</li>
                        </ol>
                        <p className="text-xs text-muted-foreground">{t("assistants.chatgpt.plans")}</p>
                    </Client>

                    <Client
                        mark={<CursorMark className="size-5" />}
                        name={t("assistants.cursor.name")}
                        guide={setup.SETUP_GUIDES.cursor}
                        guideLabel={guide}
                    >
                        <Button asChild variant="outline" size="sm" className="w-fit">
                            <a href={setup.cursorInstallLink(url)}>{t("assistants.cursor.install")}</a>
                        </Button>
                        <p>{t("assistants.cursor.manual")}</p>
                        <Copyable value={setup.cursorConfig(url)} label={t("assistants.configLabel")} />
                        <p className="text-xs text-muted-foreground">{t("assistants.cursor.signIn")}</p>
                    </Client>

                    <Client
                        // Microsoft's own file, served as it ships: its masks
                        // and gradients carry ids that would collide inline.
                        // eslint-disable-next-line @next/next/no-img-element
                        mark={<img src="/logos/vscode.svg" alt="" className="size-5" />}
                        name={t("assistants.vscode.name")}
                        guide={setup.SETUP_GUIDES.vscode}
                        guideLabel={guide}
                    >
                        <Button asChild variant="outline" size="sm" className="w-fit">
                            <a href={setup.vscodeInstallLink(url)}>{t("assistants.vscode.install")}</a>
                        </Button>
                        <p>{t("assistants.vscode.manual")}</p>
                        <Copyable value={setup.vscodeConfig(url)} label={t("assistants.configLabel")} />
                        <p className="text-xs text-muted-foreground">{t("assistants.vscode.signIn")}</p>
                    </Client>

                    <Client
                        mark={<Bot className="size-5 text-muted-foreground" aria-hidden />}
                        name={t("assistants.other.name")}
                        guideLabel={guide}
                    >
                        <p>{t("assistants.other.body")}</p>
                        <Copyable value={setup.codexCommands(url)} label={t("assistants.commandLabel")} />
                        <p className="text-xs text-muted-foreground">
                            {t.rich("assistants.other.key", {
                                header: (
                                    <code key="header" className="text-xs">
                                        Authorization: Bearer plk_...
                                    </code>
                                ),
                                link: (chunks) => (
                                    <Link key="link" href="/account/api-keys/new" className="underline">
                                        {chunks}
                                    </Link>
                                )
                            })}
                        </p>
                    </Client>
                </div>
            </CardBody>
        </Card>
    );
}
