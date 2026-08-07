# Security Policy

## Supported versions

Fixes ship in the latest published release. Earlier versions receive no
backports, so reproduce on the latest release before reporting.

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/MeisQuietude/Viewda/security/advisories/new).
Without a GitHub account, write to mail@meisquietude.com.

Do not open a public issue for a vulnerability and do not attach a sample
file that carries data you cannot share.

Useful in a report: the affected version and platform, what an attacker
gains, and the smallest input or steps that reproduce it. Expect a first
reply within a week. Once a fix ships, the advisory is published with
credit to you unless you ask otherwise.

## Scope

Viewda reads files that come from elsewhere, so malformed or hostile
Parquet input is in scope: memory corruption in the reader, code execution
through a file or a query, escapes from the sandboxed webview, tampering
with the update channel or its signatures, and any traffic beyond the
documented update check.

Out of scope: the operating system's code signing warnings for builds the
README documents as unsigned.
