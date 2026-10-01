# Publishing & releases

Releases are automated with [Changesets](https://github.com/changesets/changesets) and published to npm via [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers) — there is no `NPM_TOKEN`. See [SECURITY.md](./SECURITY.md) for the security rationale behind the pipeline. This is a pnpm workspace: the published package is `@thomasfosterau/pulpit` (`packages/pulpit`); `tests/dist-consumer` is private and never versioned or published (`privatePackages` in `.changeset/config.json`).

## The release flow

1. **Add a changeset with your change.** Run `pnpm changeset`, pick the bump (`patch` / `minor` / `major`) and write a user-facing summary, then commit the generated file alongside your change. (Changes that don't affect the published package — docs, CI, examples — need no changeset.)
2. **Merge to `main`.** The [`release`](./.github/workflows/release.yml) workflow runs and, while changesets are pending, opens or updates a **"Version Packages"** PR that applies the version bump and rolls the changesets into `CHANGELOG.md`.
3. **Merge the "Version Packages" PR.** With no changesets left, the workflow publishes the new version to npm via `pnpm publish` and trusted publishing (with provenance once the repository is public — see below), then tags the commit and creates the GitHub release.

## How the release job works

The publishing and install-script settings are explained in full in comments beside each setting in [release.yml](./.github/workflows/release.yml).

- **Versioning.** `pnpm run version` runs `changeset version`, then `vp fmt`, then `pnpm install --lockfile-only`. `.changeset/config.json` sets `"format": false` because Changesets would otherwise run the editor-only `oxfmt` shim Vite+ installs, which exits non-zero.
- **Publishing.** `pnpm run release` runs `pnpm publish --ignore-scripts`, then `changeset tag`. pnpm 11 performs the OIDC exchange itself, and only pnpm rewrites the `catalog:` / `catalog:peers` specifiers and applies `publishConfig.exports` in the published manifest, so don't switch to `npm publish`.
- **No install scripts.** The job installs with `--ignore-scripts`, sets `pnpm_config_verify_deps_before_run: "false"` so a later `pnpm run` can't re-install with scripts, and runs the workspace's own `prepare` explicitly.

### Provenance

Nothing in the pipeline requests [provenance](https://docs.npmjs.com/generating-provenance-statements). Left unset, pnpm attaches it only when the OIDC token reports a **public** repository and the registry reports the package as public; this repository is private, so releases carry none today. Don't add `--provenance` or `pnpm_config_provenance`: an explicit request from a private repository fails the publish. That also applies to the one-off manual bootstrap publish below.

## Maintainer setup (one-time)

The package is not yet published. npm's trusted-publisher binding can only be configured on an existing package, so the very first release is a one-off manual `pnpm publish` by the owner (or a one-time automation token), after which the following steps make the automated flow work end-to-end:

1. **Allow Actions to open the Version Packages PR.** In the repo: **Settings → Actions → General → Workflow permissions** → enable **"Allow GitHub Actions to create and approve pull requests"**. Without this the built-in `GITHUB_TOKEN` is forbidden from opening pull requests and the workflow fails at the PR-creation step — even though the job already grants `pull-requests: write`.
2. **Configure the trusted publisher.** On npmjs.com, open the package → **Settings → Trusted Publisher** and add:
   - Provider: **GitHub Actions**
   - Repository: `thomasfosterau/pulpit`
   - Workflow: `release.yml`
   - Environment: `release`

   Then remove any classic automation tokens for the package.

3. **Protect the `release` environment.** **Settings → Environments → `release`** → enable **Required reviewers** (yourself) and restrict deployment to the `main` branch, so publishing pauses for manual approval.
4. **Protect `main`.** Require pull requests and passing CI before merge, and disallow direct pushes, so a release can only be triggered by merging the reviewed "Version Packages" PR.
