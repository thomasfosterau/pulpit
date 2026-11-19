# Publishing

Releases use [Changesets](https://github.com/changesets/changesets) and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); there is no `NPM_TOKEN`. Packages version independently. `@thomasfosterau/pulpit-wordpress` and `@thomasfosterau/pulpit-drizzle-pg` stay `"private": true` (never versioned or published) until their bootstrap below; `tests/dist-consumer` is ignored.

## Flow

1. Add a changeset with your change (`pnpm changeset`).
2. On `trunk`, [release.yml](../.github/workflows/release.yml) opens or updates the `chore: version packages` PR (`pnpm run version`: `changeset version`, `vp fmt`, a lockfile refresh).
3. Merging it starts the `publish` job in the protected `release` environment. After approval it builds, runs `pnpm run release` (`pnpm publish --ignore-scripts` for every unpublished version, then `changeset git-tag`), and creates one GitHub release per tag.

Use `pnpm publish`, never `npm publish`: only pnpm rewrites `catalog:` / `workspace:` specifiers and applies `publishConfig.exports`. Never pass `--provenance`: npm rejects provenance from a private repository.

An adapter peers on the kernel as `workspace:^`, published as `^<kernel version>`. Before 1.0 a kernel minor leaves that range, and Changesets gives the adapter a patch with the new range.

## One-time setup (owner)

Repository settings, once:

1. **Settings → Actions → General**: allow GitHub Actions to create and approve pull requests.
2. **Settings → Environments → `release`**: required reviewer (the owner), deployments from `trunk` only.
3. Protect `trunk`: pull requests and passing CI required.

Per package (npm binds trusted publishers per package, and only to an existing one):

1. Release the kernel first. For an adapter, remove `"private": true` in a PR with a changeset for its first release (`minor` gives `0.1.0`), and update its README status.
2. Publish the first version by hand: while the release job waits for approval, check out its commit, `pnpm install --frozen-lockfile`, `vp run -r build`, then `pnpm publish --no-git-checks --ignore-scripts` in the package directory. The approved job then skips that version and tags it.
3. With the package's **next** release job waiting, add the trusted publisher on npmjs.com (package → Settings → Trusted Publisher): GitHub Actions, `thomasfosterau` / `pulpit`, workflow `release.yml`, environment `release`, allowed action **`npm publish`**. A new binding expires unless used within 2 days, so approve the job promptly, then revoke any one-time token.
