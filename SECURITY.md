# Security policy

brain-mcp serves personal notes, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability. Report it privately through GitHub instead:

1. Go to the [Security tab](https://github.com/debashishthakur/brain-mcp/security) of this repository.
2. Choose **Report a vulnerability**.
3. Describe the issue, how to reproduce it, and the impact you expect.

You should get a first response within a week. Once a fix is ready, the advisory is published with credit to you, unless you prefer to stay anonymous.

## In scope

- The OAuth 2.1 flow, login page, token handling and session binding (`src/auth/`, `src/remote.ts`)
- Scope enforcement and private notes (`src/policy.ts`, `src/tools.ts`)
- Secret redaction gaps: a credential format that leaves the server unmasked
- Path traversal or writes outside `captureDir`
- The bearer-token HTTP transport (`src/http.ts`)

## Supported versions

Only the latest commit on `main` is supported while the project is pre-1.0.
