# Vulnerability ledger

This folder is the project's own security memory. Each `VULN-*.md` is one
confirmed finding from a white-box audit; read them before hunting so a known bug
is referenced rather than re-filed, and a fixed one that comes back is flagged as
a regression. Entries are sorted open/regressed first, then by severity.

| ID | Title | Severity | Status | Location | CWE | Discovered |
|----|-------|----------|--------|----------|-----|------------|
| VULN-0001 | SSRF via DNS rebinding (TOCTOU) in safe-fetch link unfurl | Medium | Fixed | dashboard/apps/web/src/lib/safe-fetch.ts:118 | CWE-918 | 2026-08-16 |
