/**
 * A BiomeJS toolchain to execute Biome on a JavaScript project.
 */

import {
	CacheSharingMode,
	type Changeset,
	type Container,
	check,
	collection,
	type Directory,
	dag,
	func,
	get,
	keys,
	object,
	ReturnType,
	type Workspace,
} from "@dagger.io/dagger";

const DEFAULT_BASE_IMAGE =
	"node:25-alpine@sha256:f4769ca6eeb6ebbd15eb9c8233afed856e437b75f486f7fccaa81d7c8ad56007";

/** Biome configuration file names, in the order Biome prefers them. */
const CONFIG_FILES = ["biome.json", "biome.jsonc"];

/** Directories never searched for projects. */
const EXCLUDE = ["**/node_modules/**"];

/** Lockfiles and the package manager each one belongs to, in detection order. */
const LOCKFILES: [string, string][] = [
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["package-lock.json", "npm"],
	["npm-shrinkwrap.json", "npm"],
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
];

/** Package managers the packageManager setting and field may name. */
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];

/** Files that decide where and how dependencies are installed. */
const INSTALL_MARKERS = [
	"package.json",
	"pnpm-workspace.yaml",
	...LOCKFILES.map(([file]) => file),
];

/**
 * Everything an install reads, relative to the install root, and nothing
 * else, so editing source files does not re-run it.
 */
const INSTALL_INPUTS = [
	"**/package.json",
	"pnpm-workspace.yaml",
	".pnpmfile.cjs",
	".yarnrc",
	".yarnrc.yml",
	".yarn/releases/**",
	".yarn/plugins/**",
	".yarn/patches/**",
	"bunfig.toml",
	"**/.npmrc",
	"patches/**",
	...LOCKFILES.map(([file]) => file),
];

/**
 * Files an install may create or rewrite, kept out of a fix's changes.
 */
const INSTALL_OUTPUTS = [
	"**/node_modules",
	"**/.yarn",
	"**/.pnp.cjs",
	"**/.pnp.loader.mjs",
	...LOCKFILES.map(([file]) => `**/${file}`),
];

/**
 * A biome command that runs the nearest node_modules/.bin/biome between the
 * working directory and the install root, or yarn's under Plug'n'Play, and
 * says how to fix it when there is none.
 */
function biomeWrapper(root: string): string {
	return `#!/bin/sh
d="$PWD"
while :; do
  if [ -x "$d/node_modules/.bin/biome" ]; then exec "$d/node_modules/.bin/biome" "$@"; fi
  if [ "$d" = /src ] || [ "$d" = / ]; then break; fi
  d=$(dirname "$d")
done
if [ -f /src/.pnp.cjs ]; then exec yarn biome "$@"; fi
echo "biome is not installed: add @biomejs/biome to the devDependencies of ${joinPath(root, "package.json")} (or of a package.json between it and the project)" >&2
exit 127
`;
}

/** The pnpm store, on a cache volume. */
const PNPM_STORE = "/root/.pnpm-store";

/** Exit status of the biome wrapper when the project does not install Biome. */
const NOT_INSTALLED = 127;

/**
 * Join workspace paths into a workspace-root-relative path ("." for the root).
 */
function joinPath(...parts: string[]): string {
	const out: string[] = [];
	for (const part of parts.join("/").split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.length === 0 ? "." : out.join("/");
}

/** The parent of a workspace-root-relative path, or null for the root. */
function parentPath(path: string): string | null {
	if (path === ".") return null;
	const i = path.lastIndexOf("/");
	return i < 0 ? "." : path.slice(0, i);
}

/** A workspace-root-relative path and every directory above it. */
function ancestors(path: string): string[] {
	const out: string[] = [];
	for (let p: string | null = path; p !== null; p = parentPath(p)) out.push(p);
	return out;
}

/** Whether path is strictly below dir. */
function isBelow(path: string, dir: string): boolean {
	return path !== dir && (dir === "." || path.startsWith(`${dir}/`));
}

/** Whether path is dir or below it. */
function contains(dir: string, path: string): boolean {
	return path === dir || isBelow(path, dir);
}

/** path relative to dir, which contains it. */
function relativeTo(dir: string, path: string): string {
	if (path === dir) return ".";
	return dir === "." ? path : path.slice(dir.length + 1);
}

/** Absolute workspace path for a workspace-root-relative path. */
function absPath(path: string): string {
	return path === "." ? "/" : `/${path}`;
}

/** Absolute container path of a workspace-root-relative path. */
function srcPath(path: string): string {
	return path === "." ? "/src" : `/src/${path}`;
}

/** The workspace cwd as a workspace-root-relative path. */
async function cwdPath(ws: Workspace): Promise<string> {
	return joinPath(await ws.cwd());
}

/**
 * Strip comments and trailing commas from JSONC, leaving strings intact.
 */
function stripJsonc(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end < 0 ? text.length : end + 2;
		} else {
			out += c;
			i++;
		}
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Parse JSON or JSONC, returning undefined when it does not parse. */
function parseJsonc(text: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(stripJsonc(text));
	} catch {
		return undefined;
	}
}

/**
 * Whether a Biome configuration is a project root. Biome v2 treats a
 * configuration as a root unless it sets `"root": false`.
 */
function isRootConfig(contents: string): boolean {
	const parsed = parseJsonc(contents);
	if (parsed !== undefined) return parsed?.root !== false;
	return !/"root"\s*:\s*false/.test(stripJsonc(contents));
}

/**
 * Whether the Biome configuration in dir (workspace-root-relative) is a root.
 * A directory without a readable configuration counts as a root.
 */
async function isRootDir(ws: Workspace, dir: string): Promise<boolean> {
	const configs = ws.directory(absPath(dir), { include: CONFIG_FILES });
	const entries = await configs.entries();
	const name = CONFIG_FILES.find((f) => entries.includes(f));
	if (name === undefined) return true;
	return isRootConfig(await configs.file(name).contents());
}

/**
 * The nearest directory at or above dir holding a Biome configuration.
 */
async function configDirAbove(
	ws: Workspace,
	dir: string,
): Promise<string | null> {
	let best: string | null = null;
	for (const name of CONFIG_FILES) {
		const found = await ws.findUp(name, { from: absPath(dir) });
		if (!found) continue;
		const foundDir = parentPath(joinPath(found)) ?? ".";
		if (best === null || isBelow(foundDir, best)) best = foundDir;
	}
	return best;
}

/**
 * The root project a configuration directory belongs to: dir itself, or for a
 * nested `"root": false` configuration, the nearest root above it.
 */
async function owningRoot(ws: Workspace, dir: string): Promise<string> {
	let current = dir;
	while (!(await isRootDir(ws, current))) {
		const parent = parentPath(current);
		const above = parent === null ? null : await configDirAbove(ws, parent);
		if (above === null) return dir;
		current = above;
	}
	return current;
}

/**
 * Directories holding a Biome configuration at or below start, plus the
 * nearest one above it, as workspace-root-relative paths.
 */
async function configDirs(ws: Workspace, start: string): Promise<string[]> {
	const cwd = await cwdPath(ws);
	const found = await ws.findRoots({
		start: absPath(start),
		markers: CONFIG_FILES,
		exclude: EXCLUDE,
	});
	return found.map((p) => joinPath(cwd, p));
}

/**
 * The directories whose Biome configuration is not ignored by git.
 */
async function notGitignored(ws: Workspace, dirs: string[]): Promise<string[]> {
	if (dirs.length === 0) return dirs;
	const candidates = dirs.flatMap((d) =>
		CONFIG_FILES.map((f) => joinPath(d, f)),
	);
	const kept = new Set(
		(
			await ws
				.directory("/", { include: candidates, gitignore: true })
				.glob("**/biome.json*")
		).map((p) => parentPath(joinPath(p)) ?? "."),
	);
	return dirs.filter((d) => kept.has(d));
}

/**
 * Biome root projects at or below the workspace cwd, plus the one enclosing it.
 */
async function discoverProjects(ws: Workspace): Promise<string[]> {
	const dirs = await notGitignored(ws, await configDirs(ws, await cwdPath(ws)));
	const roots = await Promise.all(dirs.map((d) => owningRoot(ws, d)));
	return [...new Set(roots)].sort();
}

/**
 * Where a project's dependencies are installed, and with what.
 */
interface Install {
	/** Install root, relative to the workspace. */
	root: string;
	/** Package manager: npm, pnpm, yarn or bun. */
	packageManager: string;
}

/**
 * Find the install for a project: the nearest workspace root at or above it
 * (pnpm-workspace.yaml, or a package.json with "workspaces"), else the nearest
 * lockfile's directory, else the nearest package.json's. Null when there is no
 * package.json at or above the project.
 *
 * The package manager is the configured one, else the one the install root's
 * package.json names in "packageManager", else the one its lockfile belongs
 * to, else npm.
 */
async function findInstall(
	ws: Workspace,
	project: string,
	packageManager: string,
): Promise<Install | null> {
	const dirs = ancestors(project);
	const markers = ws.directory("/", {
		include: dirs.flatMap((d) => INSTALL_MARKERS.map((f) => joinPath(d, f))),
		exclude: ["**/node_modules"],
	});
	const present = new Set((await markers.glob("**/*")).map((p) => joinPath(p)));
	const has = (dir: string, file: string) => present.has(joinPath(dir, file));
	const manifest = async (dir: string) =>
		parseJsonc(await markers.file(joinPath(dir, "package.json")).contents()) ??
		{};
	if (!dirs.some((d) => has(d, "package.json"))) return null;

	let root: string | null = null;
	let nearestLock: string | null = null;
	let nearestPackage: string | null = null;
	for (const dir of dirs) {
		if (has(dir, "pnpm-workspace.yaml")) {
			root = dir;
			break;
		}
		if (has(dir, "package.json")) {
			if ((await manifest(dir)).workspaces) {
				root = dir;
				break;
			}
			nearestPackage ??= dir;
		}
		if (nearestLock === null && LOCKFILES.some(([f]) => has(dir, f))) {
			nearestLock = dir;
		}
	}
	const at = (root ?? nearestLock ?? nearestPackage) as string;

	if (packageManager === "") {
		const field = has(at, "package.json")
			? (await manifest(at)).packageManager
			: undefined;
		const declared = typeof field === "string" ? field.split("@")[0] : "";
		if (PACKAGE_MANAGERS.includes(declared)) {
			packageManager = declared;
		} else if (has(at, "pnpm-workspace.yaml")) {
			packageManager = "pnpm";
		} else {
			packageManager = LOCKFILES.find(([f]) => has(at, f))?.[1] ?? "npm";
		}
	}
	return { root: at, packageManager };
}

/**
 * Biome's summary of what `check --write` left unfixed, e.g. "Found 1 error.
 * Skipped 1 suggested fixes (apply with biome check --write --unsafe).", or
 * "" when it fixed everything.
 */
function fixSummary(output: string): string {
	const lines = output.split("\n").map((l) => l.trim());
	const found = lines.filter((l) =>
		/^Found \d+ (errors?|warnings?|infos?)\.$/.test(l),
	);
	const skipped = lines.find((l) => /^Skipped \d+ suggested fixes?\.$/.test(l));
	const parts = [...found];
	if (skipped) {
		parts.push(
			`${skipped.replace(/\.$/, "")} (apply with biome check --write --unsafe).`,
		);
	}
	return parts.join(" ");
}

/** The last lines of a command's output. */
function tail(output: string, lines = 15): string {
	return output.trim().split("\n").slice(-lines).join("\n");
}

/** What a failed command left behind. */
interface CommandFailure {
	exitCode?: number;
	stdout?: string;
	stderr?: string;
}

/**
 * An error naming the step that failed, e.g. "install failed (pnpm install,
 * exit 1)" or "biome check failed (exit 1)", followed by the end of its
 * output. A missing Biome is reported as run-biome explains it.
 */
function stepError(step: string, err: unknown, command?: string[]): Error {
	const e = err as CommandFailure;
	if (typeof e?.exitCode !== "number") {
		return new Error(`${step} failed: ${errorMessage(err)}`);
	}
	if (e.exitCode === NOT_INSTALLED) {
		return new Error(tail(e.stderr ?? ""));
	}
	const cmd = command ? `${command.join(" ")}, ` : "";
	const output = tail(`${e.stdout ?? ""}\n${e.stderr ?? ""}`);
	return new Error(
		`${step} failed (${cmd}exit ${e.exitCode})${output ? `:\n${output}` : ""}`,
	);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Indent every line after the first, for a nested list item. */
function indent(text: string): string {
	return text.split("\n").join("\n  ");
}

/**
 * A container ready to run biome in a project, and the source laid into it.
 */
interface Runner {
	ctr: Container;
	/** Source mounted at /src: the install root, or the project without one. */
	source: Directory;
	/** Workspace path mounted at /src. */
	mount: string;
}

/**
 * A Biome project, rooted at a workspace-relative directory holding a root
 * Biome configuration.
 */
@object()
export class BiomeProject {
	/**
	 * Project root, relative to the workspace.
	 */
	@func()
	path: string;

	baseImageAddress: string;

	packageManager: string;

	installFlags: string[];

	environment: string[];

	constructor(
		path: string,
		baseImageAddress: string,
		packageManager: string,
		installFlags: string[],
		environment: string[],
	) {
		this.path = path;
		this.baseImageAddress = baseImageAddress;
		this.packageManager = packageManager;
		this.installFlags = installFlags;
		this.environment = environment;
	}

	/**
	 * Lint this project.
	 */
	@func()
	@check()
	async lint(ws: Workspace): Promise<void> {
		const { ctr } = await this.runner(ws, await this.nestedRoots(ws));
		try {
			await ctr.withExec(["biome", "check"]).sync();
		} catch (err) {
			throw stepError("biome check", err);
		}
	}

	/**
	 * Apply Biome's safe fixes to this project and return the changes.
	 *
	 * The changes are rooted at the caller's working directory, where the CLI
	 * applies them: a project below it is placed at its relative path, and an
	 * enclosing project contributes only the working directory's subtree.
	 * Fixes are returned even when diagnostics Biome cannot fix remain.
	 *
	 * @param files Files to fix, relative to the project root.
	 * @param fixFilter Patterns, relative to the project root, of files to include in the changeset. Empty includes every file Biome fixed.
	 */
	@func()
	async fix(
		ws: Workspace,
		files: string[] = [],
		fixFilter: string[] = [],
	): Promise<Changeset> {
		const nested = await this.nestedRoots(ws);
		const { ctr, source, mount } = await this.runner(ws, nested);
		const ran = ctr.withExec(["biome", "check", "--write", ...files], {
			expect: ReturnType.Any,
		});
		const exitCode = await ran.exitCode();
		const output = `${await ran.stdout()}\n${await ran.stderr()}`;
		// Say what Biome left for a human: the changeset cannot carry it.
		const summary = fixSummary(output);
		if (summary !== "") {
			console.log(`${this.path}: ${summary}`);
		}
		if (exitCode !== 0) {
			// Biome exits 1 when diagnostics remain that it could not fix; the
			// safe fixes it applied are still worth returning.
			const remaining =
				exitCode === 1 &&
				/errors were emitted while (applying fixes|running checks)/.test(
					output,
				);
			if (!remaining) {
				throw stepError("biome check --write", {
					exitCode,
					stderr: output,
				});
			}
		}

		const cwd = await cwdPath(ws);
		const place = (tree: Directory) => {
			const files = dag.directory().withDirectory(".", tree, {
				include: fixFilter.length > 0 ? fixFilter : undefined,
				exclude: INSTALL_OUTPUTS,
			});
			return contains(cwd, this.path)
				? dag.directory().withDirectory(relativeTo(cwd, this.path), files)
				: files.directory(relativeTo(this.path, cwd));
		};
		// The install mounts every package.json, nested projects' included;
		// they are not this project's to change.
		const after = nested.reduce(
			(dir, sub) => dir.withoutDirectory(relativeTo(this.path, sub)),
			ran.directory("."),
		);
		const before = source.directory(relativeTo(mount, this.path));
		return place(after).changes(place(before));
	}

	/**
	 * Other root projects nested in this one, relative to the workspace. Each
	 * is linted on its own, so this project leaves them alone.
	 */
	private async nestedRoots(ws: Workspace): Promise<string[]> {
		const dirs = (await configDirs(ws, this.path)).filter((d) =>
			isBelow(d, this.path),
		);
		const roots = await Promise.all(
			dirs.map(async (d) => ((await isRootDir(ws, d)) ? d : null)),
		);
		return roots.filter((d): d is string => d !== null);
	}

	/**
	 * Container that runs biome, with this project as the working directory.
	 * With a package.json at or above the project, the install root's
	 * dependencies are installed and the source laid over them, and the
	 * project's own Biome runs; otherwise npx fetches Biome on demand.
	 */
	private async runner(ws: Workspace, nested: string[]): Promise<Runner> {
		const install = await findInstall(ws, this.path, this.packageManager);
		const mount = install?.root ?? this.path;
		const source = ws.directory(absPath(mount), {
			exclude: [
				"**/node_modules",
				...nested.map((sub) => relativeTo(mount, sub)),
			],
			gitignore: true,
		});
		let ctr: Container;
		if (install === null) {
			ctr = nodeBase(this.baseImageAddress, "npm").withNewFile(
				"/usr/local/bin/biome",
				'#!/bin/sh\nexec npx --yes @biomejs/biome "$@"\n',
				{ permissions: 0o755 },
			);
		} else {
			ctr = (await this.installed(ws, install)).withNewFile(
				"/usr/local/bin/biome",
				biomeWrapper(install.root),
				{ permissions: 0o755 },
			);
		}
		for (const pair of this.environment) {
			const i = pair.indexOf("=");
			ctr =
				i < 0
					? ctr.withEnvVariable(pair, "")
					: ctr.withEnvVariable(pair.slice(0, i), pair.slice(i + 1));
		}
		ctr = ctr
			.withDirectory("/src", source)
			// Plain output, so reports read cleanly in error messages.
			.withEnvVariable("NO_COLOR", "1")
			.withWorkdir(srcPath(relativeTo(mount, this.path)));
		return { ctr, source, mount };
	}

	/**
	 * The install root with its dependencies installed, from the install
	 * inputs only, so the step stays cached until they change.
	 */
	private async installed(ws: Workspace, install: Install): Promise<Container> {
		const pm = install.packageManager;
		const setup = nodeBase(this.baseImageAddress, pm);
		try {
			await setup.sync();
		} catch (err) {
			throw stepError(`${pm} setup`, err);
		}
		const inputs = await installInputs(ws, install.root);
		// pnpm 12 ignores the store directory from the environment; name it on
		// the command line so the cache volume is used.
		const cmd = [
			pm,
			"install",
			...this.installFlags,
			...(pm === "pnpm" ? ["--store-dir", PNPM_STORE] : []),
		];
		const installed = setup
			.withDirectory("/src", inputs)
			.withWorkdir("/src")
			.withExec(cmd);
		try {
			await installed.sync();
		} catch (err) {
			throw stepError("install", err, cmd);
		}
		return installed;
	}
}

/** Dependency fields whose values may point at a local directory. */
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
	"overrides",
	"resolutions",
];

/** A dependency spec that installs from a local path. */
const LOCAL_SPEC = /^(?:file|link|portal):(.+)$/;

/**
 * A path relative to dir, as a path below the install root, or null when it
 * leaves the root: that cannot be mounted with the root.
 */
function within(dir: string, path: string): string | null {
	if (path.startsWith("/")) return null;
	const out = dir === "." ? [] : dir.split("/");
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part !== "..") out.push(part);
		else if (out.pop() === undefined) return null;
	}
	return out.length === 0 ? "." : out.join("/");
}

/** Every string value in a (possibly nested) dependency map. */
function specs(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (value !== null && typeof value === "object") {
		return Object.values(value).flatMap(specs);
	}
	return [];
}

/**
 * Everything the install reads, relative to the install root, and nothing
 * else, so editing source files does not re-run it. Package managers copy
 * `file:`, `link:` and `portal:` directory dependencies and pnpm's injected
 * workspace packages at install time, so those directories come in whole,
 * and they link workspace packages' `bin` files, so those come too. If
 * a package.json does not parse, the install gets the full source instead.
 */
async function installInputs(ws: Workspace, root: string): Promise<Directory> {
	const tree = ws.directory(absPath(root), {
		include: ["**/package.json"],
		exclude: ["**/node_modules"],
	});
	const files = await tree.glob("**/package.json");
	const manifests = await Promise.all(
		files.map(async (file) => {
			const text = await tree.file(file).contents();
			try {
				return {
					dir: parentPath(joinPath(file)) ?? ".",
					pkg: JSON.parse(text),
				};
			} catch {
				return null;
			}
		}),
	);
	if (manifests.some((m) => m === null)) {
		return ws.directory(absPath(root), {
			exclude: ["**/node_modules"],
			gitignore: true,
		});
	}

	const byName = new Map<string, string>();
	for (const m of manifests) {
		if (m && typeof m.pkg?.name === "string") byName.set(m.pkg.name, m.dir);
	}
	const local = new Set<string>();
	const bins = new Set<string>();
	for (const m of manifests) {
		if (!m) continue;
		// Package managers link workspace packages' bin files at install time.
		for (const bin of specs(m.pkg?.bin)) {
			const file = within(m.dir, bin);
			if (file !== null && file !== ".") bins.add(file);
		}
		const fields = DEPENDENCY_FIELDS.flatMap((f) => [
			m.pkg?.[f],
			m.pkg?.pnpm?.[f],
		]);
		for (const spec of specs(fields)) {
			const match = LOCAL_SPEC.exec(spec);
			const dir = match ? within(m.dir, match[1]) : null;
			if (dir !== null) local.add(dir);
		}
		for (const [name, meta] of Object.entries(m.pkg?.dependenciesMeta ?? {})) {
			const dir = byName.get(name);
			if (dir !== undefined && (meta as { injected?: boolean })?.injected) {
				local.add(dir);
			}
		}
	}
	const extra = [
		...[...local].filter((p) => p !== ".").flatMap((p) => [p, `${p}/**`]),
		...bins,
	];
	return ws.directory(absPath(root), {
		include: [...INSTALL_INPUTS, ...extra],
		exclude: ["**/node_modules"],
	});
}

/**
 * Node container with every package manager's cache on a volume, corepack
 * enabled for pnpm and yarn, and browser downloads and git hooks switched off:
 * Biome needs none of them.
 */
function nodeBase(image: string, pm: string): Container {
	const base = dag
		.container()
		.from(image)
		.withMountedCache("/root/.npm", dag.cacheVolume("npm-cache"))
		.withEnvVariable("npm_config_cache", "/root/.npm")
		// Concurrent yarn 1 installs corrupt a shared cache.
		.withMountedCache("/root/.yarn-cache", dag.cacheVolume("yarn-cache"), {
			sharing: CacheSharingMode.Locked,
		})
		.withEnvVariable("YARN_CACHE_FOLDER", "/root/.yarn-cache")
		.withMountedCache("/root/.bun-cache", dag.cacheVolume("bun-cache"))
		.withEnvVariable("BUN_INSTALL_CACHE_DIR", "/root/.bun-cache")
		.withMountedCache("/root/.corepack", dag.cacheVolume("corepack"))
		.withEnvVariable("COREPACK_HOME", "/root/.corepack")
		.withEnvVariable("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
		.withEnvVariable("CI", "true")
		.withEnvVariable("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
		.withEnvVariable("PUPPETEER_SKIP_DOWNLOAD", "1")
		.withEnvVariable("CYPRESS_INSTALL_BINARY", "0")
		.withEnvVariable("HUSKY", "0")
		.withEnvVariable("SKIP_INSTALL_SIMPLE_GIT_HOOKS", "1");
	if (pm === "pnpm" || pm === "yarn") {
		// Images from node 25 on no longer ship corepack, and --force replaces
		// the yarn they still ship.
		const ctr =
			pm === "pnpm"
				? base
						.withMountedCache(PNPM_STORE, dag.cacheVolume("pnpm-store"))
						.withEnvVariable("pnpm_config_store_dir", PNPM_STORE)
				: base;
		return ctr.withExec([
			"sh",
			"-c",
			"command -v corepack >/dev/null 2>&1 || npm install -g --force corepack; corepack enable",
		]);
	}
	if (pm === "bun") {
		return base.withExec([
			"sh",
			"-c",
			"command -v bun >/dev/null 2>&1 || npm install -g bun",
		]);
	}
	return base;
}

/**
 * Biome projects in a workspace, keyed by the directory of their root Biome
 * configuration.
 */
@collection()
export class BiomeProjects {
	/**
	 * Project root paths.
	 */
	@keys()
	paths: string[];

	baseImageAddress: string;

	packageManager: string;

	installFlags: string[];

	environment: string[];

	constructor(
		paths: string[],
		baseImageAddress: string,
		packageManager: string,
		installFlags: string[],
		environment: string[],
	) {
		this.paths = paths;
		this.baseImageAddress = baseImageAddress;
		this.packageManager = packageManager;
		this.installFlags = installFlags;
		this.environment = environment;
	}

	/**
	 * The Biome project rooted at path.
	 */
	@get()
	project(path: string): BiomeProject {
		return new BiomeProject(
			path,
			this.baseImageAddress,
			this.packageManager,
			this.installFlags,
			this.environment,
		);
	}

	/**
	 * Lint the selected Biome projects.
	 */
	@func()
	@check()
	async lint(ws: Workspace): Promise<void> {
		const results = await Promise.allSettled(
			this.paths.map((p) => this.project(p).lint(ws)),
		);
		const failures = results.flatMap((r, i) =>
			r.status === "rejected"
				? [`- ${this.paths[i]}: ${indent(errorMessage(r.reason))}`]
				: [],
		);
		if (failures.length > 0) {
			throw new Error(
				`Biome failed in ${failures.length} project(s):\n${failures.join("\n")}`,
			);
		}
	}
}

@object()
export class Biomejs {
	baseImageAddress: string;

	packageManager: string;

	installFlags: string[];

	environment: string[];

	constructor(
		/**
		 * Base image for Biome containers. It must provide Node.js and npm.
		 */
		baseImageAddress: string = DEFAULT_BASE_IMAGE,
		/**
		 * Package manager that installs dependencies: npm, yarn, pnpm or bun.
		 * Empty detects it from package.json's packageManager field, else the
		 * lockfile, else npm.
		 */
		packageManager: string = "",
		/**
		 * Extra arguments for the install command, e.g. ["--ignore-scripts"].
		 */
		installFlags: string[] = [],
		/**
		 * Environment variables for Biome, as KEY=VALUE.
		 */
		environment: string[] = [],
	) {
		this.baseImageAddress = baseImageAddress;
		this.packageManager = packageManager;
		this.installFlags = installFlags;
		this.environment = environment;
	}

	/**
	 * Biome projects at or below the working directory, keyed by project root.
	 */
	@func()
	async projects(ws: Workspace): Promise<BiomeProjects> {
		return new BiomeProjects(
			await discoverProjects(ws),
			this.baseImageAddress,
			this.packageManager,
			this.installFlags,
			this.environment,
		);
	}
}
