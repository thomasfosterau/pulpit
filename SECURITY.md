# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's [**Report a vulnerability**](https://github.com/thomasfosterau/pulpit/security/advisories/new) button (Security → Advisories), **not** through public issues.

You can expect an initial response within a few days. Please include a description, reproduction steps, and the affected version.

## Supply-chain hardening

This package is published with a hardened, automated pipeline designed to resist supply-chain attacks (e.g. self-propagating npm worms that steal credentials and publish trojanized versions):

- **No long-lived npm token.** Releases use npm [**OIDC Trusted Publishing**](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with a short-lived, workflow-bound OIDC token. There is no `NPM_TOKEN` secret to steal from CI. The publish step is `pnpm publish --provenance`; pnpm 11 performs the OIDC exchange itself.
- **Provenance.** Every published version carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements), cryptographically linking the artifact to the exact source commit and workflow.
- **Install scripts disabled in the release job.** The release workflow installs dependencies with `pnpm install --frozen-lockfile --ignore-scripts`, so a compromised (transitive) dependency cannot execute install hooks in the privileged job; the workspace's own `prepare` step (the Effect-patched `tsc`) is then run explicitly. CI installs with scripts, but `allowBuilds` in `pnpm-workspace.yaml` names the only packages whose install scripts may run.
- **Pinned actions.** All GitHub Actions are pinned to full commit SHAs, so a hijacked tag cannot inject malicious workflow code.
- **Supply-chain delay.** `minimumReleaseAge` in `pnpm-workspace.yaml` holds a newly published third-party version for one day before pnpm will install it.
- **Least privilege.** Workflows default to `permissions: {}`; each job opts into only the scopes it needs. CI checks out with `persist-credentials: false`.
- **Manual approval gate.** Publishing runs in a protected `release` environment that requires manual approval.
- **Locked dependencies.** Installs use `pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`; Dependabot proposes updates for review.

## Release pipeline

The publishing pipeline and its one-time maintainer setup (trusted publisher, protected `release` environment, branch protection) are documented in [PUBLISHING.md](./PUBLISHING.md).
