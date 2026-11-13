/**
 * Ready-made ways to post to a topic, written with this deployment's own
 * address. Pure, so the exact text can be asserted.
 */

export interface AlertSnippet {
    readonly id: "curl" | "ntfy" | "json" | "gotify" | "kuma" | "grafana";
    readonly text: string;
}

export function alertSnippets(base: string, topicId: string, secret: string): AlertSnippet[] {
    const server = `${base}/api/alerts/${topicId}`;
    const url = `${server}/${secret}`;
    return [
        { id: "curl", text: `curl -d "Backup finished" ${url}` },
        {
            id: "ntfy",
            text: `curl -H "Title: Disk almost full" -H "Priority: high" -H "Tags: warning,disk" -H "Click: https://example.com/disk" -d "Only 5% left on /srv" ${url}`
        },
        {
            id: "json",
            text: `curl -H "Authorization: Bearer ${secret}" -H "Content-Type: application/json" -d '{"title":"Deploy failed","message":"Build 512 failed","severity":"urgent","tags":["deploy"],"dedupKey":"build-512"}' ${server}`
        },
        {
            id: "gotify",
            text: `curl "${server}/message?token=${secret}" -d "title=Nightly job" -d "message=It finished" -d "priority=5"`
        },
        { id: "kuma", text: `Server URL: ${server}\nTopic: ${secret}` },
        {
            id: "grafana",
            text: `Webhook URL: ${url}
Custom payload: {"title": "{{ .CommonLabels.alertname }}", "message": "{{ .CommonAnnotations.summary }}"}`
        }
    ];
}
