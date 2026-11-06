# biomejs

A [Dagger](https://dagger.io) toolchain that runs [Biome](https://biomejs.dev)
on JavaScript projects, using each project's own Biome configuration and
version.

## Requirements

Requires Dagger v1.0.0-beta.22 or later.

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
trailing commas are fine). Listing a project's files (see [Files](#files))
also reads its source, the same upload its lint uses. Listing runs no
container and no Biome.

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

## Files

Each project's files form a collection keyed by workspace path, and each file
is a `lint` check:

```sh
dagger check -l --all --biomejs        # one line per file
```

A project's files are the ones Biome checks, found from the source and the
Biome configurations without running Biome:

- files of a type the project's Biome handles, in any case, and the root
  configuration file. Every Biome 2 handles `.js`, `.jsx`, `.mjs`, `.cjs`,
  `.ts`, `.tsx`, `.mts`, `.cts`, `.json`, `.jsonc`, `.css`, `.graphql`,
  `.gql`, `.grit`, `.vue`, `.svelte` and `.astro`; 2.3 adds `.html`, and 2.6
  `.htm`, `.md`, `.markdown`, `.scss`, `.yaml` and `.yml`. The version is the
  one the install root's lockfile resolves, else an exact version in
  `package.json`; with neither (a range and no lockfile), only the types
  every Biome 2 handles are files;
- included by `files.includes`, read as Biome reads it: patterns are matched
  in order and the last match wins, a directory a pattern excludes is
  skipped whole, `**` spans directories and `{a,b}` alternatives. A nested
  `"root": false` configuration's `files.includes` replaces the root's below
  it; one without its own uses that of a configuration it `extends` by path,
  or the root's through `"//"`. Biome 1's `files.include` and `files.ignore`
  are read the same way;
- not `node_modules`, files ignored by `.gitignore`, nested root projects, or
  `package-lock.json` and `npm-shrinkwrap.json`, which Biome leaves to npm.

Discovery installs nothing and runs no container: it reads the source,
the configurations and the lockfile. It cannot read a configuration that a
project `extends` from a package, or one chosen with `BIOME_CONFIG_PATH`. If
Biome and discovery then disagree, the check says so instead of passing:
a file Biome skips fails as not processed, and an error in a file Biome
checks without a check of its own fails the project's checks (see below). A
project whose files cannot be found fails alone, on its configuration
file.

## Checks

| Check | Address | Description |
| --- | --- | --- |
| `lint` | `biomejs/projects/files/lint` | Lint this file (`biome check`). |

```sh
dagger check --biomejs                                  # every file of every project in view
dagger check --check lint                               # checks named lint, any module
dagger check --biomejs-biome-project=packages/ui        # one project
dagger check --biomejs-biome-file=app/src/index.ts      # one file
dagger check biomejs/projects/files/lint --biomejs-biome-project=app
```

Selection flags, from `dagger check --help` (module settings are listed by
`dagger settings biomejs`, see [Settings](#settings)):

| Flag | Selects |
| --- | --- |
| `--biomejs`, `--by-biomejs` | checks from this module |
| `--check lint` | checks named `lint` |
| `--biomejs-biome-project PATH` | one project (repeatable) |
| `--biomejs-biome-file PATH` | one file, by workspace path (repeatable) |
| `--biomejs-projects` | every project |

Run checks with `dagger check`, in CI too: `dagger call` on a check function
does not fail the command when the check fails.

### One Biome run per project

Biome runs once per project, however many of its files are selected. Every
file check of a project receives the project's selected files, as `dagger
check` filtered them, and builds the same command from them:

- With no file of the project selected out, Biome checks the whole project:
  `biome check --verbose --colors=off --max-diagnostics=none
  --no-errors-on-unmatched --files-ignore-unknown=true`.
- Otherwise, the same command names the selected files, sorted.

Its output goes to files, whatever its exit status. A second shared step,
in its own pinned Node.js image whatever the base image,
splits it into one result per selected file, by the location of each
diagnostic and the list of files `--verbose` says Biome processed, and each
check reads only its own:

- A file with an error diagnostic fails with Biome's report for that file.
  Warnings and infos do not fail it.
- A failure no file explains, such as a configuration error or a missing
  Biome, fails every check of the project. So does an error in a file Biome
  checked that has no check of its own, which only the whole-project run can
  reach.
- A selected file Biome did not process fails as not processed: discovery
  and Biome disagree about it, so a pass would have nothing behind it.
- A failed install fails every check of the project with the install's
  error.

Each result is bounded, so a large report never truncates a check. Logs and
spans of the shared run appear under whichever check ran it first; the other
checks reuse its result.

A failure names the file and the step that failed, for example:

```
app/src/index.ts: biome check failed (exit 1):
src/index.ts:1:1 lint/suspicious/noDebugger  FIXABLE  ━━━━━━━━━━
  × This is an unexpected use of the debugger statement.
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

**Without a `package.json`** at or above the project, `npx` fetches Biome
2.6.6, so a standalone Biome configuration works without a Node project.

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

## Migrating from the batch form

Earlier versions linted per project, with `lint` a check on each project and
`projects.batch.lint(ws)` running several. Now:

| Before | Now |
| --- | --- |
| check `biomejs/projects/lint` | check `biomejs/projects/files/lint`, one per file |
| `projects.batch.lint(ws)` | `projects.lint(ws)`, a plain function |
| `projects.subset(keys: [...]).batch.lint(ws)` | `projects.subset(keys: [...]).lint(ws)` |
| `run(projects.get(key: "app").lint(ws))` | `projects.get(key: "app").lint(ws)`, which raises |

## Use from another module

`projects(ws)` returns the collection of projects, and a project's
`files(ws)` the collection of its files. `keys`, `get(key:)` and
`subset(keys:)` work on both. `lint(ws)` on the projects, a project, or a
set of files is a plain function, not a check: it lints them with one Biome
run per project and raises naming every failing file.

```dang
let projects = biomejs.projects(ws)
projects.keys                                             # ["app", "packages/ui", ...]
projects.get(key: "app").fix(ws)                          # Changeset for one project
projects.subset(keys: ["app", "packages/ui"]).lint(ws)    # raises on failure
projects.get(key: "app").files(ws).keys                   # ["app/biome.json", "app/src/index.ts", ...]
projects.get(key: "app").files(ws).subset(keys: ["app/src/index.ts"]).lint(ws)
```

A file's `lint` check takes its project's files as `selection`, which
`dagger check` passes. Called through a dependency, a check returns a `Check`
that has not run yet. Run it and raise on failure:

```dang
let run(check: Check!): Void {
  if (check.pass == false) {
    raise check.error.message ?? "check failed"
  }
  null
}

let files = biomejs.projects(ws).get(key: "app").files(ws)
run(files.get(key: "app/src/index.ts").lint(ws, selection: files))
```

Direct calls do not apply `dagger check`'s filtering: called this way,
`selection` is what you pass, and Biome names its files rather than checking
the whole project.

The end-to-end tests in `.dagger/modules/e2e` exercise all of this.
