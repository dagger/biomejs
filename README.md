# biomejs

A [Dagger](https://dagger.io) toolchain that runs [Biome](https://biomejs.dev)
on JavaScript projects, using each project's own Biome configuration and
version.

## Requirements

Requires Dagger v1.0.0-beta.15 or later.

## Install

```sh
dagger install github.com/dagger/biomejs
```

## Projects

Every directory holding a root Biome configuration (`biome.json` or
`biome.jsonc`) is a project. A configuration with `"root": false` is a nested
configuration in Biome v2: it belongs to the project above it and is not a
project of its own.

Projects form a collection keyed by directory, relative to the workspace root:

```sh
dagger list biomejs-biome-projects -a
```

A project covers its directory and everything below it, except nested root
projects. Those are linted on their own, so no file is linted twice and Biome
never sees a second root configuration.

### Discovery

Projects are found by configuration file name, in one walk of the workspace
that skips `node_modules` and directories ignored by `.gitignore`. Each
configuration is read to see whether it sets `"root": false` (comments and
trailing commas are fine). Listing runs no container and no Biome.

### Your working directory selects projects

Which projects you see depends on where you run `dagger`:

- **Inside a project's subdirectory:** the enclosing project, plus any
  projects nested below that directory.
- **At a project root:** that project and the projects below it, never the
  ones above it.
- **In a directory that belongs to no project:** the projects below it.

Given `app/biome.json`, `packages/ui/biome.json`, `packages/ui/legacy/biome.json`
and a `"root": false` configuration in `app/src/biome.jsonc`:

```sh
cd app/src && dagger check           # checks app
cd packages/ui && dagger check       # checks packages/ui and packages/ui/legacy
cd packages && dagger check          # checks packages/ui and packages/ui/legacy
```

## Checks

| Check | Address | Description |
| --- | --- | --- |
| `lint` | `biomejs/projects/lint` | Lint this project (`biome check`). |

```sh
dagger check -l --all --biomejs                         # one line per project
dagger check --biomejs                                  # every project in view
dagger check --check lint                               # checks named lint, any module
dagger check --biomejs-biome-project=packages/ui        # one project
dagger check biomejs/projects/lint --biomejs-biome-project=app
```

Selection flags, from `dagger check --help` (module settings are listed by
`dagger settings biomejs`, see [Settings](#settings)):

| Flag | Selects |
| --- | --- |
| `--biomejs`, `--by-biomejs` | checks from this module |
| `--check lint` | checks named `lint` |
| `--biomejs-biome-project PATH` | one project (repeatable) |
| `--biomejs-projects` | every project |

Run checks with `dagger check`, in CI too: `dagger call` on a check function
does not fail the command when the check fails.

The selected projects are linted concurrently. A failure names every
failing project and the step that failed, for example:

```
Biome failed in 3 project(s):
- a: install failed (pnpm install, exit 1):
  ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" ...
- b: biome check failed (exit 1):
  index.js format ...
- c: biome is not installed: add @biomejs/biome to the devDependencies of c/package.json (...)
```

## Fixing lint issues

`fix` runs `biome check --write` and returns Biome's safe fixes as a
changeset, for every file type Biome fixes (JavaScript, TypeScript, JSON, CSS
and more). Fixes are returned even when diagnostics without a safe fix remain; `fix`
then prints Biome's count of what is left (for example
`failing: Found 1 error. Skipped 1 suggested fixes (apply with biome check --write --unsafe).`).
`dagger call` cannot select an item from a collection yet, so pick the project
by its key in the Dagger shell. `export .` writes the changes:

```sh
dagger -c 'biomejs | projects | get packages/ui | fix | export .'
dagger -c 'biomejs | projects | get packages/ui | fix | as-patch | contents'   # review first
```

The changes are rooted at your working directory. When you run from inside a
project's subdirectory, only files below that directory change. Dependencies
the install adds (`node_modules`, lockfiles) are never part of the changes.

`fix` takes `files` (paths relative to the project, default: all) and
`fixFilter` (patterns relative to the project for the files to keep in the
changeset, default: all).

`fix` is not a `@generate` generator, so `dagger generate` does not run it. A
generator adds a staleness check to `dagger check`, which would run Biome a
second time next to `lint`.

## Dependencies

Biome runs from the project directory.

**Without a `package.json`** at or above the project, `npx` fetches the latest
Biome, so a standalone Biome configuration works without a Node project.

**With one**, dependencies are installed and the project's own Biome runs: the
nearest `node_modules/.bin/biome` between the project and the install root, or
yarn's under Plug'n'Play. If there is none, the check fails with
`biome is not installed: add @biomejs/biome to the devDependencies of ...`
rather than fetching a different version.

- **Install root.** The nearest workspace root at or above the project: a
  directory with `pnpm-workspace.yaml`, or a `package.json` with
  `"workspaces"`. Failing that, the nearest lockfile's directory, then the
  nearest `package.json`'s. A package inside a monorepo therefore installs
  with the whole workspace, so `workspace:` and `catalog:` dependencies
  resolve and a nested project uses the Biome pinned at the root.
- **Package manager.** The `packageManager` setting if set. Otherwise the
  `packageManager` field of the install root's `package.json`, then its
  lockfile (`pnpm-lock.yaml` or `pnpm-workspace.yaml`: pnpm, `yarn.lock`:
  yarn, `bun.lock`/`bun.lockb`: bun), then npm. pnpm and yarn run through
  corepack, installed when the image lacks it, at the version the
  `packageManager` field pins.
- **Caching.** The install sees only what it reads: every `package.json`,
  lockfiles, `pnpm-workspace.yaml`, `.npmrc`, `.yarnrc*`, `.yarn/{releases,plugins,patches}`,
  `.pnpmfile.cjs`, `bunfig.toml` and `patches/`, plus the directories of
  `file:`, `link:` and `portal:` dependencies and of pnpm workspace packages
  marked `injected`, which package managers copy at install time, and the
  `bin` files of workspace packages, which they link. If a
  `package.json` does not parse, the install sees the full source instead.
  The rest of the source is laid over the result, so editing a source file
  does not reinstall. Package manager caches and corepack live on cache
  volumes; pnpm is pointed at its cache with `--store-dir`.
- **Less noise.** Browser downloads (Playwright, Puppeteer, Cypress) and git
  hook installers (husky, simple-git-hooks) are switched off. Install scripts
  still run. They see only the install inputs, so a script that needs source
  files fails; pass `--ignore-scripts` through `installFlags`.

The install root, or the project itself, is mounted without `node_modules`
and without files ignored by `.gitignore`.

## Settings

Set them with `dagger settings`, or in `dagger.toml`:

```sh
dagger settings biomejs installFlags '["--ignore-scripts"]'
dagger settings -u biomejs installFlags      # unset, back to the default
```

```toml
[modules.biomejs.settings]
baseImageAddress = "node:22-alpine"      # default: node:25-alpine; any image with node and npm
packageManager = "pnpm"                  # default: "" (detect); npm, yarn, pnpm or bun
installFlags = ["--ignore-scripts"]      # default: []; appended to the install command
environment = ["BIOME_CONFIG_PATH=config/biome.json"]  # default: []; KEY=VALUE for Biome
```

## Use from another module

`projects(ws)` returns the collection. `keys`, `get(key:)`, `subset(keys:)`
and `batch` work on it:

```dang
let projects = biomejs.projects(ws)
projects.keys                                             # ["app", "packages/ui", ...]
projects.get(key: "app").fix(ws)                          # Changeset for one project
projects.subset(keys: ["app", "packages/ui"]).batch.lint(ws)
```

A check called through a dependency returns a `Check` that has not run yet.
Run it and raise on failure:

```dang
let run(check: Check!): Void {
  if (check.pass == false) {
    raise check.error.message ?? "check failed"
  }
  null
}

run(biomejs.projects(ws).batch.lint(ws))
run(biomejs.projects(ws).get(key: "app").lint(ws))
```

The end-to-end tests in `.dagger/modules/e2e` exercise all of this.
