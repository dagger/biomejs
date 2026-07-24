# biomejs

A [Dagger](https://dagger.io) toolchain that runs [Biome](https://biomejs.dev)
on a JavaScript project, using your project's own Biome configuration and
version.

## Functions

| Function | Description                                               |
| -------- | --------------------------------------------------------- |
| `lint`   | Lint the source code (a `@check`).                        |
| `fix`    | Fix lint issues; returns the changes as a `Changeset`.    |

## Usage

Install the module in your workspace:

```sh
dagger install github.com/dagger/biomejs
```

Run the lint check:

```sh
dagger check               # run every check in the workspace
dagger check biomejs:lint  # just the Biome check
```

Fix lint issues — returns a changeset; approve it to apply the fixes to your
workspace (or pass `-y` to auto-apply):

```sh
dagger api call biomejs fix
```

## Working directory awareness

Functions run from your current working directory within the workspace. The
whole workspace is mounted — so shared configuration like a root
`biome.json` still resolves — but Biome itself runs from the directory you
invoke `dagger` from. Run from the workspace root to cover everything, or
from a subdirectory to scope `lint` and `fix` to that subtree.

If the workspace root holds no `package.json`, the dependency install is
skipped and `npx` fetches Biome on demand — a standalone Biome config works
without a Node project.
