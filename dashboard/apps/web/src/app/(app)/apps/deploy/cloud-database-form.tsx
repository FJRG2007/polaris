"use client";

/**
 * A data engine that lives in a cloud: connect one that exists, or - where the
 * provider documents an API for it - create one there with the user's own key.
 * Validated as it is typed against the schema the action runs.
 */

import { useTranslations } from "@/components/i18n/i18n-provider";
import { useState, useTransition } from "react";
import { Button, Input, Select } from "@polaris/ui";
import {
    CLOUD_CREATE_FIELDS,
    CLOUD_FIELDS,
    KAFKA_SASL_MECHANISMS,
    cloudAmqpCreateSchema,
    cloudConnectSchema,
    cloudCreateSchema,
    cloudProvidersFor,
    isCloudCreateProvider,
    type CloudConnectInput,
    type CloudCreateProvider,
    type CloudEngine,
    type CloudField
} from "@polaris/core";
import * as deployActions from "./actions";
import { Field } from "./form-field";

const SECRET_FIELDS: readonly CloudField[] = ["password", "token"];
/** Engines connected to with one connection string that carries the account. */
const CONNECTION_STRING: readonly CloudEngine[] = ["postgres", "mongo", "redis"];

export function CloudDatabaseForm({
    environmentId,
    engine,
    name,
    provider,
    onDone
}: {
    environmentId: string;
    engine: CloudEngine;
    name: string;
    provider: string;
    onDone: () => void;
}) {
    const t = useTranslations("deploy");
    const chosen = cloudProvidersFor(engine).find((one) => one.id === provider);
    const [mode, setMode] = useState<"connect" | "create">("connect");
    const [values, setValues] = useState<Partial<Record<CloudField, string>>>({});
    const [tls, setTls] = useState(true);
    const [create, setCreate] = useState({
        apiKey: "",
        plan: "lemur",
        region: "amazon-web-services::us-east-1"
    });
    const managed = isCloudCreateProvider(provider) ? CLOUD_CREATE_FIELDS[provider] : null;
    const [hosted, setHosted] = useState({
        apiKey: "",
        account: "",
        region: managed?.region ?? ""
    });
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    if (!chosen) return null;

    // The schema checks every field; the select only offers its own mechanisms.
    const connectDraft = {
        environmentId,
        name: name.trim(),
        engine,
        provider,
        tls,
        ...values
    } as CloudConnectInput;
    const createDraft = { environmentId, name: name.trim(), ...create };
    const hostedDraft = { environmentId, name: name.trim(), provider, ...hosted };
    const parsed =
        mode === "connect"
            ? cloudConnectSchema.safeParse(connectDraft)
            : managed
              ? cloudCreateSchema.safeParse(hostedDraft)
              : cloudAmqpCreateSchema.safeParse(createDraft);
    const issues = parsed.success ? [] : parsed.error.issues;
    const issueFor = (field: string) => {
        const found = issues.find((one) => one.path[0] === field);
        // An empty field is incomplete, not wrong: it is marked required instead.
        const typed =
            mode === "connect"
                ? values[field as CloudField]
                : ((managed ? hosted : create) as Record<string, string>)[field];
        if (!found || !typed) return undefined;
        return t.has(found.message) ? t(found.message) : found.message;
    };

    function submit() {
        setError(null);
        startTransition(async () => {
            const result =
                mode === "connect"
                    ? await deployActions.connectCloudDatabaseAction(connectDraft)
                    : managed
                      ? await deployActions.createCloudDatabaseAction(
                            hostedDraft as Parameters<
                                typeof deployActions.createCloudDatabaseAction
                            >[0]
                        )
                      : await deployActions.createCloudAmqpDatabaseAction(createDraft);
            if (result.error) setError(result.error);
            else onDone();
        });
    }

    return (
        <div className="flex flex-col gap-3">
            {chosen.create && (
                <Field label={t("view.database.cloud.mode")}>
                    <Select
                        value={mode}
                        onValueChange={(value) => setMode(value as "connect" | "create")}
                        options={[
                            { value: "connect", label: t("view.database.cloud.connect") },
                            { value: "create", label: t("view.database.cloud.create") }
                        ]}
                    />
                </Field>
            )}
            {mode === "connect" && !chosen.create && chosen.consoleUrl && (
                <p className="text-sm text-muted-foreground">
                    <a
                        className="underline"
                        href={chosen.consoleUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                    >
                        {chosen.label}
                    </a>
                    {" - "}
                    {t("view.database.cloud.openConsole")}
                </p>
            )}
            {mode === "connect" &&
                CLOUD_FIELDS[engine].map(({ field, required }) => (
                    <Field
                        key={field}
                        label={`${t(field === "url" && engine === "kafka" ? "view.database.cloud.field_url_kafka" : field === "url" && CONNECTION_STRING.includes(engine) ? "view.database.cloud.field_url_connection" : `view.database.cloud.field_${field}`)}${required ? " *" : ""}`}
                        error={issueFor(field)}
                    >
                        {field === "saslMechanism" ? (
                            <Select
                                value={values.saslMechanism ?? "PLAIN"}
                                onValueChange={(value) =>
                                    setValues({ ...values, saslMechanism: value })
                                }
                                options={KAFKA_SASL_MECHANISMS.map((one) => ({
                                    value: one,
                                    label: one
                                }))}
                            />
                        ) : (
                            <Input
                                type={SECRET_FIELDS.includes(field) ? "password" : "text"}
                                value={values[field] ?? ""}
                                onChange={(event) =>
                                    setValues({ ...values, [field]: event.target.value })
                                }
                                autoComplete="off"
                            />
                        )}
                    </Field>
                ))}
            {mode === "connect" && engine === "kafka" && provider === "other" && (
                <Field label={t("view.database.cloud.tls")}>
                    <Select
                        value={tls ? "tls" : "plaintext"}
                        onValueChange={(value) => setTls(value === "tls")}
                        options={[
                            { value: "tls", label: t("view.database.cloud.tlsOn") },
                            { value: "plaintext", label: t("view.database.cloud.tlsOff") }
                        ]}
                    />
                </Field>
            )}
            {mode === "create" && managed && (
                <>
                    <Field
                        label={`${t(`view.database.cloud.hosted.${provider as CloudCreateProvider}.apiKey`)} *`}
                        error={issueFor("apiKey")}
                    >
                        <Input
                            type="password"
                            value={hosted.apiKey}
                            onChange={(event) =>
                                setHosted({ ...hosted, apiKey: event.target.value })
                            }
                            autoComplete="off"
                        />
                    </Field>
                    <Field
                        label={`${t(`view.database.cloud.hosted.${provider as CloudCreateProvider}.account`)}${managed.account === "required" ? " *" : ""}`}
                        error={issueFor("account")}
                    >
                        <Input
                            type={provider === "upstash" ? "email" : "text"}
                            value={hosted.account}
                            onChange={(event) =>
                                setHosted({ ...hosted, account: event.target.value })
                            }
                            autoComplete="off"
                        />
                    </Field>
                    <Field
                        label={`${t("view.database.cloud.region")} *`}
                        hint={t(`view.database.cloud.hosted.${provider as CloudCreateProvider}.regionHint`)}
                        error={issueFor("region")}
                    >
                        <Input
                            value={hosted.region}
                            onChange={(event) =>
                                setHosted({ ...hosted, region: event.target.value })
                            }
                        />
                    </Field>
                </>
            )}
            {mode === "create" && !managed && (
                <>
                    <Field
                        label={`${t("view.database.cloud.apiKey")} *`}
                        error={issueFor("apiKey")}
                    >
                        <Input
                            type="password"
                            value={create.apiKey}
                            onChange={(event) =>
                                setCreate({ ...create, apiKey: event.target.value })
                            }
                            autoComplete="off"
                        />
                    </Field>
                    <Field label={`${t("view.database.cloud.plan")} *`} error={issueFor("plan")}>
                        <Input
                            value={create.plan}
                            onChange={(event) => setCreate({ ...create, plan: event.target.value })}
                        />
                    </Field>
                    <Field
                        label={`${t("view.database.cloud.region")} *`}
                        error={issueFor("region")}
                    >
                        <Input
                            value={create.region}
                            onChange={(event) =>
                                setCreate({ ...create, region: event.target.value })
                            }
                        />
                    </Field>
                </>
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button
                onClick={submit}
                disabled={pending || !parsed.success}
                aria-disabled={!parsed.success}
            >
                <span className="min-w-0 truncate" title={chosen.label}>
                    {mode === "create"
                        ? t("view.database.cloud.createSubmitIn", { provider: chosen.label })
                        : t("view.database.cloud.connectSubmit")}
                </span>
            </Button>
        </div>
    );
}
