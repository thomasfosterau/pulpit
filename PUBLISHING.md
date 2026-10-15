# Publishing & releases

Releases are automated with [Changesets](https://github.com/changesets/changesets) and published to npm via [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers) — there is no `NPM_TOKEN`. See [SECURITY.md](./SECURITY.md) for the security rationale behind the pipeline. This is a pnpm workspace with two packages under `packages/`, versioned and published independently (`.changeset/config.json` has no `fixed` or `linked` groups):

| Package | Directory | Published |
| --- | --- | --- |
| `@thomasfosterau/pulpit` | `packages/pulpit` | Through the release flow below (no release yet). |
| `@thomasfosterau/pulpit-wordpress` | `packages/pulpit-wordpress` | Not yet: `"private": true` until the owner completes [its one-time setup](#adding-pulpit-wordpress-to-the-release-flow). |

A private package is never versioned, tagged or published (`privatePackages` in `.changeset/config.json`; `pnpm publish -r` skips it), and neither is `tests/dist-consumer`, which is also listed under `ignore`.

## The release flow

1. **Add a changeset with your change.** Run `pnpm changeset`, pick each changed package and its bump (`patch` / `minor` / `major`) and write a user-facing summary, then commit the generated file alongside your change. (Changes that don't affect a published package — docs, CI, examples — need no changeset.)
2. **Merge to `trunk`.** The [`release`](./.github/workflows/release.yml) workflow runs and, while changesets are pending, opens or updates a **"Version Packages"** PR that applies the version bump and rolls the changesets into `CHANGELOG.md`.
3. **Merge the "Version Packages" PR.** With no changesets left, the workflow publishes each package whose version is not yet on npm via `pnpm publish` and trusted publishing (with provenance once the repository is public — see below), then tags the commit (`@thomasfosterau/pulpit@x.y.z`, `@thomasfosterau/pulpit-wordpress@x.y.z`) and creates one GitHub release per new tag.

## How the release job works

The publishing and install-script settings are explained in full in comments beside each setting in [release.yml](./.github/workflows/release.yml).

- **Versioning.** `pnpm run version` runs `changeset version`, then `vp fmt`, then `pnpm install --lockfile-only`. `.changeset/config.json` sets `"format": false` because Changesets would otherwise run the editor-only `oxfmt` shim Vite+ installs, which exits non-zero.
- **Publishing.** `pnpm run release` runs `pnpm -r --filter './packages/*' publish --ignore-scripts`, then `changeset tag`. pnpm 11 performs the OIDC exchange itself, and only pnpm rewrites the `catalog:` / `catalog:peers` / `workspace:` specifiers and applies `publishConfig.exports` in the published manifest, so don't switch to `npm publish`. `pnpm publish -r` skips a version that is already on npm, and `changeset tag` creates one tag per package for each version not yet tagged, reporting each to the Changesets action through its `CHANGESETS_OUTPUT` file, so a release of both packages pushes two tags and creates two GitHub releases.
- **The adapter's peer on the kernel.** `pulpit-wordpress` peers on the kernel as `workspace:^`, which `pnpm publish` rewrites to `^<the kernel's version>`. Before 1.0 that range excludes the kernel's next minor. Changesets v3 gives a package whose peer range a new version leaves a `patch` bump of its own (checked with `changeset status` against the pending changesets), so a kernel minor also republishes the adapter with the new range; a kernel patch inside the range doesn't. This applies only once the adapter is public.
- **No install scripts.** The job installs with `--ignore-scripts`, sets `pnpm_config_verify_deps_before_run: "false"` so a later `pnpm run` can't re-install with scripts, and runs the workspace's own `prepare` explicitly.

### Provenance

Nothing in the pipeline requests [provenance](https://docs.npmjs.com/generating-provenance-statements), so a release from this private repository carries none; never add `--provenance` (it fails the publish from a private repository, including the manual bootstrap publish below). The full reasoning is beside the publish step in [release.yml](./.github/workflows/release.yml).

## Maintainer setup (one-time)

Neither package is published yet. The steps below are the owner's, for `@thomasfosterau/pulpit`; [the next section](#adding-pulpit-wordpress-to-the-release-flow) repeats the per-package ones for `@thomasfosterau/pulpit-wordpress`. npm's trusted-publisher binding can only be configured on an existing package, so the very first release is a one-off manual `pnpm publish` by the owner (or a one-time automation token), after which the following steps make the automated flow work end-to-end:

1. **Allow Actions to open the Version Packages PR.** In the repo: **Settings → Actions → General → Workflow permissions** → enable **"Allow GitHub Actions to create and approve pull requests"**. Without this the built-in `GITHUB_TOKEN` is forbidden from opening pull requests and the workflow fails at the PR-creation step — even though the job already grants `pull-requests: write`.
2. **Configure the trusted publisher.** On npmjs.com, open the package → **Settings → Trusted Publisher** and add:
   - Provider: **GitHub Actions**
   - Repository: `thomasfosterau/pulpit`
   - Workflow: `release.yml`
   - Environment: `release`

   Then remove any classic automation tokens for the package.

3. **Protect the `release` environment.** **Settings → Environments → `release`** → enable **Required reviewers** (yourself) and restrict deployment to the `trunk` branch, so publishing pauses for manual approval.
4. **Protect `trunk`.** Require pull requests and passing CI before merge, and disallow direct pushes, so a release can only be triggered by merging the reviewed "Version Packages" PR.

## Adding `pulpit-wordpress` to the release flow

npm trusted publishing is configured **per package**, so `@thomasfosterau/pulpit-wordpress` needs its own bootstrap. Every step is the owner's: no agent publishes, creates the npm package or configures the binding.

1. **Release the kernel first**, if it isn't on npm yet. The adapter's published peer range is taken from the kernel's version at publish time.
2. **Make the package public in a PR.** Remove `"private": true` from `packages/pulpit-wordpress/package.json`, and add a changeset for it (its first release).
3. **Publish its first version once by hand.** The trusted-publisher binding can only be configured on an existing package, so the first publish is a one-off manual `pnpm publish` by the owner (or a one-time automation token), never with `--provenance` (see above). Merging the first "Version Packages" PR that versions the adapter starts a release job that waits for approval in the `release` environment. Before approving it, check out that merge commit, run `pnpm install --frozen-lockfile` and `vp run -r build`, and run `pnpm publish` from `packages/pulpit-wordpress`. The approved job's `pnpm publish -r` then skips that already-published version and `changeset tag` still tags it. Without the manual publish, the job's OIDC publish of this package fails.
4. **Configure its trusted publisher.** On npmjs.com, open `@thomasfosterau/pulpit-wordpress` → **Settings → Trusted Publisher** and add the same entry as for the kernel: provider **GitHub Actions**, repository `thomasfosterau/pulpit`, workflow `release.yml`, environment `release`. Do this before approving that release job, then remove any classic automation token used for step 3.

Steps 1, 3 and 4 of the kernel's setup above (workflow permissions, the `release` environment, `trunk` protection) are repository settings, done once for both packages.
