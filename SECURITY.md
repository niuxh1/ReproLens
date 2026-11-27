# Security Policy

## Supported versions

ReproLens is currently pre-1.0. Security fixes are applied to the `main` branch.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Report it privately to the repository maintainer with:

- affected version/commit;
- reproduction steps;
- expected and actual behavior;
- impact assessment;
- any suggested fix.

## Trust model

ReproLens is designed for a **trusted local research environment** by default.

- The HTTP control plane does not provide authentication or multi-tenant isolation.
- Do not expose the service to a network interface, reverse proxy, or container port without adding authentication and authorization.
- `local` Runner executes experiment code on the host and is explicitly marked unsafe.
- CodeAgent integrations run third-party CLI tools. Treat them as host-level code execution unless you place them inside a dedicated VM or sandbox.
- Uploaded papers, repositories, and model-generated plans must be treated as untrusted input.
- Secrets belong in `.env`, the OS keychain, or a secret manager; never commit them.

## Recommended deployment

- Bind to `127.0.0.1` unless a trusted gateway enforces authentication.
- Use Docker or SSH for experiments when possible.
- Run ReproLens and CodeAgent inside a disposable VM when evaluating untrusted papers or repositories.
- Keep `data/`, `.work/`, `.env`, and generated evidence out of version control.
- Review every patch diff before approval.