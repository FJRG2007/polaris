/**
 * Ready-made ways to post to an alert address, written with this deployment's
 * own address. Pure, so the exact text can be asserted.
 *
 * Windows PowerShell's `curl` is an alias of Invoke-WebRequest, which takes
 * none of curl's flags ("A positional parameter cannot be found"), so the
 * Windows line is its own: Invoke-RestMethod, which every PowerShell has.
 */

export interface AlertSnippet {
    readonly id: "curl" | "powershell" | "ntfy" | "json" | "gotify" | "kuma" | "grafana";
    readonly text: string;
}

export function alertSnippets(base: string, addressId: string, secret: string): AlertSnippet[] {
    const server = `${base}/api/alerts/${addressId}`;
    const url = `${server}/${secret}`;
    return [
        { id: "curl", text: `curl -d "Backup finished" ${url}` },
        {
            id: "powershell",
            text: `Invoke-RestMethod -Method Post -Uri "${url}" -ContentType "text/plain; charset=utf-8" -Body "Backup finished"`
        },
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
