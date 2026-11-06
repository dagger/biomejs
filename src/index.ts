/**
 * A BiomeJS toolchain to execute Biome on a JavaScript project.
 */

import {
	CacheSharingMode,
	type Changeset,
	type CollectionDelta,
	type Container,
	check,
	collection,
	type Directory,
	dag,
	delta,
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

/**
 * The biome wrapper, off PATH and always called by this path, so that npx,
 * yarn or pnpm resolving `biome` can never find the wrapper itself.
 */
const BIOME = "/opt/dagger-biomejs/biome";

/** Exit status of the biome wrapper when the project does not install Biome. */
const NOT_INSTALLED = 127;

/**
 * File extensions every Biome 2 release checks, in any case. A file of any
 * other type is not a lint check: Biome only warns that it cannot handle it.
 */
const BIOME_EXTENSIONS = [
	".js",
	".jsx",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".mts",
	".cts",
	".json",
	".jsonc",
	".css",
	".graphql",
	".gql",
	".grit",
	".vue",
	".svelte",
	".astro",
];

/**
 * File extensions Biome checks from a version on. They are files only when
 * the project's Biome version is known: a file an older Biome skips would
 * fail as not processed, while one a newer Biome checks without a check of
 * its own still fails the project's checks when Biome reports an error in it.
 */
const VERSIONED_EXTENSIONS: [number[], string[]][] = [
	[[2, 3, 0], [".html"]],
	[
		[2, 6, 0],
		[".htm", ".md", ".markdown", ".scss", ".yaml", ".yml"],
	],
];

/** Biome 1 checks no Grit files, but these JSON files by name. */
const BIOME_1_FILES = [".babelrc", ".swcrc"];

/**
 * The Biome npx runs for a project without a package.json, pinned so that
 * results are reproducible and discovery knows what it checks.
 */
const FALLBACK_BIOME_VERSION = "2.6.6";

/**
 * Image the report indexer runs in, whatever the base image: it only needs
 * Node.js. Pinned by digest.
 */
const INDEXER_IMAGE =
	"node:25.2.1-alpine@sha256:f4769ca6eeb6ebbd15eb9c8233afed856e437b75f486f7fccaa81d7c8ad56007";

/** Files Biome refuses to process because another tool owns them. */
const PROTECTED_FILES = ["package-lock.json", "npm-shrinkwrap.json"];

/**
 * Flags of the shared lint command. --verbose lists the files Biome
 * processed, which tells a passing file from one Biome never looked at.
 */
const LINT_FLAGS = [
	"--verbose",
	"--colors=off",
	"--max-diagnostics=none",
	"--no-errors-on-unmatched",
	// Unknown files are never checks, and --verbose would report each.
	"--files-ignore-unknown=true",
];

/** Where the shared lint command's output is kept for the indexer. */
const LINT_STDOUT = "/biome-check.stdout";
const LINT_STDERR = "/biome-check.stderr";

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

/** A files.includes pattern. A null re matches nothing. */
interface IncludePattern {
	negated: boolean;
	re: RegExp | null;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * One path segment of a Biome glob as a regular expression: `*` matches
 * within the segment, `{a,b}` either alternative and `\\` escapes. Biome
 * rejects character classes, so a pattern with one matches nothing.
 */
function globSegment(segment: string): string | null {
	let out = "";
	let i = 0;
	while (i < segment.length) {
		const c = segment[i];
		if (c === "\\" && i + 1 < segment.length) {
			out += escapeRegExp(segment[i + 1]);
			i += 2;
		} else if (c === "*") {
			while (segment[i] === "*") i++;
			out += "[^/]*";
		} else if (c === "{" && segment.indexOf("}", i) > i) {
			const end = segment.indexOf("}", i);
			const alternatives = segment
				.slice(i + 1, end)
				.split(",")
				.map(globSegment);
			if (alternatives.some((a) => a === null)) return null;
			out += `(?:${alternatives.join("|")})`;
			i = end + 1;
		} else if (c === "[") {
			return null;
		} else {
			out += escapeRegExp(c);
			i++;
		}
	}
	return out;
}

/** A Biome glob as a regular expression; `**` is a whole segment. */
function globRegExp(glob: string): RegExp | null {
	const segments = glob.split("/");
	let out = "";
	for (let i = 0; i < segments.length; i++) {
		const last = i === segments.length - 1;
		if (segments[i] === "**") {
			out += last ? ".*" : "(?:[^/]+/)*";
			continue;
		}
		const segment = globSegment(segments[i]);
		if (segment === null) return null;
		out += last ? segment : `${segment}/`;
	}
	return new RegExp(`^${out}$`);
}

function includePattern(raw: string): IncludePattern {
	const negated = raw.startsWith("!");
	let glob = raw.replace(/^!!?/, "");
	while (glob.startsWith("./")) glob = glob.slice(2);
	return { negated, re: globRegExp(glob) };
}

/**
 * Whether the last pattern matching path includes it (true) or excludes it
 * (false); null when none matches.
 */
function lastMatch(patterns: IncludePattern[], path: string): boolean | null {
	let result: boolean | null = null;
	for (const p of patterns) {
		if (p.re?.test(path)) result = !p.negated;
	}
	return result;
}

function strings(value: unknown): string[] | null {
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: null;
}

/**
 * A configuration's files.includes, or null when it sets none and so
 * includes everything. Biome 1's include and ignore lists are read as
 * includes, with a directory standing for its contents.
 */
function includePatterns(
	config: Record<string, unknown> | undefined,
): IncludePattern[] | null {
	const files = config?.files as Record<string, unknown> | undefined;
	const includes = strings(files?.includes);
	if (includes !== null) return includes.map(includePattern);
	const include = strings(files?.include);
	const ignore = strings(files?.ignore);
	if (include === null && ignore === null) return null;
	return [
		...(include ?? ["**"]).flatMap((p) => [p, `${p}/**`]).map(includePattern),
		...(ignore ?? []).map((p) => includePattern(`!${p}`)),
	];
}

/**
 * The Biome configurations of a project, which decide what Biome processes.
 */
interface ProjectConfigs {
	/** The project's root configuration file, relative to the project. */
	rootFile: string | null;
	/**
	 * files.includes of each configuration directory, relative to the
	 * project, null for one that includes everything.
	 */
	patterns: Map<string, IncludePattern[] | null>;
}

/**
 * A configuration's effective files.includes: its own, else that of the last
 * configuration it extends that sets one. "//" is the root configuration;
 * paths are read from the project. A package it extends cannot be read
 * without installing it, so its includes are not seen.
 */
async function configIncludes(
	tree: Directory,
	listed: Set<string>,
	dir: string,
	config: Record<string, unknown> | undefined,
	root: IncludePattern[] | null,
	depth = 0,
): Promise<IncludePattern[] | null> {
	const own = includePatterns(config);
	if (own !== null || depth > 8) return own;
	const extended = config?.extends;
	const entries =
		typeof extended === "string" ? [extended] : (strings(extended) ?? []);
	for (const entry of [...entries].reverse()) {
		if (entry === "//") {
			if (root !== null) return root;
			continue;
		}
		const file = within(dir, entry);
		if (file === null || !listed.has(file)) continue;
		const parsed = parseJsonc(await tree.file(file).contents());
		const includes = await configIncludes(
			tree,
			listed,
			parentPath(file) ?? ".",
			parsed,
			root,
			depth + 1,
		);
		if (includes !== null) return includes;
	}
	return null;
}

/**
 * Read the project's configurations from its file listing: its root
 * configuration and the `"root": false` ones nested in it. A nested
 * configuration's files.includes replaces the root's below it, matched from
 * the nested configuration's directory.
 */
async function readConfigs(
	tree: Directory,
	files: string[],
): Promise<ProjectConfigs> {
	const byDir = new Map<string, string>();
	for (const file of files) {
		const name = file.slice(file.lastIndexOf("/") + 1);
		if (!CONFIG_FILES.includes(name)) continue;
		const dir = parentPath(file) ?? ".";
		if (!byDir.has(dir) || name === CONFIG_FILES[0]) byDir.set(dir, file);
	}
	const listed = new Set(files);
	const parsed = await Promise.all(
		[...byDir].map(
			async ([dir, file]) =>
				[dir, parseJsonc(await tree.file(file).contents())] as const,
		),
	);
	const root = parsed.find(([dir]) => dir === ".")?.[1];
	const rootPatterns = await configIncludes(tree, listed, ".", root, null);
	const patterns = new Map<string, IncludePattern[] | null>([
		[".", rootPatterns],
	]);
	for (const [dir, config] of parsed) {
		if (dir === ".") continue;
		patterns.set(
			dir,
			await configIncludes(tree, listed, dir, config, rootPatterns),
		);
	}
	return { rootFile: byDir.get(".") ?? null, patterns };
}

/** A version "1.2.3" as [1, 2, 3], or null when it is not one. */
function parseVersion(text: string): number[] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
	return match ? match.slice(1, 4).map(Number) : null;
}

function atLeast(version: number[], min: number[]): boolean {
	for (let i = 0; i < 3; i++) {
		if (version[i] !== min[i]) return version[i] > min[i];
	}
	return true;
}

/**
 * Whether a Biome version handles a file name. With the version unknown,
 * only the types every Biome 2 release handles count.
 */
function biomeHandles(version: number[] | null, name: string): boolean {
	const lower = name.toLowerCase();
	if (version !== null && version[0] < 2) {
		return (
			BIOME_1_FILES.includes(lower) ||
			BIOME_EXTENSIONS.some((ext) => ext !== ".grit" && lower.endsWith(ext))
		);
	}
	const extensions = [
		...BIOME_EXTENSIONS,
		...VERSIONED_EXTENSIONS.flatMap(([min, exts]) =>
			version !== null && atLeast(version, min) ? exts : [],
		),
	];
	return extensions.some((ext) => lower.endsWith(ext));
}

/**
 * Versions of @biomejs/biome a lockfile resolves, from npm, pnpm, yarn and
 * bun lockfiles.
 */
function lockedBiomeVersions(name: string, text: string): string[] {
	if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
		const lock = parseJsonc(text) as
			| {
					packages?: Record<string, { version?: string }>;
					dependencies?: Record<string, { version?: string }>;
			  }
			| undefined;
		return [
			...Object.entries(lock?.packages ?? {})
				.filter(([key]) => key.endsWith("node_modules/@biomejs/biome"))
				.map(([, pkg]) => pkg.version ?? ""),
			lock?.dependencies?.["@biomejs/biome"]?.version ?? "",
		];
	}
	const patterns: Record<string, RegExp> = {
		"pnpm-lock.yaml": /^\s*['"]?\/?@biomejs\/biome[@/](\d+\.\d+\.\d+)/gm,
		"yarn.lock":
			/^"?@biomejs\/biome@[^\n]*:\n(?:[ \t]+[^\n]*\n)*?[ \t]+version:? "?(\d+\.\d+\.\d+)/gm,
		"bun.lock": /"@biomejs\/biome@(\d+\.\d+\.\d+)"/g,
	};
	const pattern = patterns[name];
	return pattern ? [...text.matchAll(pattern)].map((m) => m[1]) : [];
}

/**
 * The Biome version a project runs, read from files without installing:
 * the one version the install root's lockfile resolves, else an exact
 * version the project's or the install root's package.json names. npx runs
 * the pinned fallback. Null when none of these settles it.
 */
async function projectBiomeVersion(
	source: Directory,
	install: Install | null,
	projectDir: string,
): Promise<number[] | null> {
	if (install === null) return parseVersion(FALLBACK_BIOME_VERSION);
	const entries = new Set(await source.entries());
	const read = async (file: string) => {
		try {
			return await source.file(file).contents();
		} catch {
			return "";
		}
	};
	for (const [lockfile] of LOCKFILES) {
		if (!entries.has(lockfile)) continue;
		const versions = new Set(
			lockedBiomeVersions(lockfile, await read(lockfile)).filter(
				(v) => parseVersion(v) !== null,
			),
		);
		if (versions.size === 1) return parseVersion([...versions][0]);
		if (versions.size > 1) return null;
	}
	for (const dir of [...new Set([projectDir, "."])]) {
		const manifest = parseJsonc(await read(joinPath(dir, "package.json")));
		for (const field of ["devDependencies", "dependencies"]) {
			const spec = (manifest?.[field] as Record<string, unknown> | undefined)?.[
				"@biomejs/biome"
			];
			if (typeof spec === "string" && /^\d+\.\d+\.\d+$/.test(spec)) {
				return parseVersion(spec);
			}
		}
	}
	return null;
}

/** The configuration directory a project-relative directory belongs to. */
function configOwner(configs: ProjectConfigs, dir: string): string {
	return ancestors(dir).find((d) => configs.patterns.has(d)) ?? ".";
}

/**
 * Whether Biome checks a project-relative file: one of the types it handles,
 * not a file another tool owns, and included by the configuration it belongs
 * to. As in Biome, a directory whose last matching pattern excludes it is
 * skipped whole, and a file must match an including pattern last. The root
 * configuration file is always checked.
 */
function biomeChecks(
	configs: ProjectConfigs,
	version: number[] | null,
	file: string,
): boolean {
	if (file === configs.rootFile) return true;
	const name = file.slice(file.lastIndexOf("/") + 1);
	if (PROTECTED_FILES.includes(name)) return false;
	if (!biomeHandles(version, name)) return false;
	const parts = file.split("/");
	for (let i = 1; i < parts.length; i++) {
		const dir = parts.slice(0, i).join("/");
		const owner = configOwner(configs, parentPath(dir) ?? ".");
		const patterns = configs.patterns.get(owner);
		if (patterns && lastMatch(patterns, relativeTo(owner, dir)) === false) {
			return false;
		}
	}
	const owner = configOwner(configs, parentPath(file) ?? ".");
	const patterns = configs.patterns.get(owner);
	return !patterns || lastMatch(patterns, relativeTo(owner, file)) === true;
}

/** Sorted, without duplicates. */
function sortedUnique(items: string[]): string[] {
	return [...new Set(items)].sort();
}

/** Paths for a message, the first few of a long list. */
function listPaths(paths: string[], max = 10): string {
	return paths.length <= max
		? paths.join(", ")
		: `${paths.slice(0, max).join(", ")} and ${paths.length - max} more`;
}

/**
 * Raise when any file failed, naming each and why. Files that failed for the
 * same reason, such as a missing Biome, are named together.
 */
async function raiseFailures(
	files: string[],
	results: string[],
): Promise<void> {
	const byMessage = new Map<string, string[]>();
	files.forEach((file, i) => {
		if (results[i] === "") return;
		byMessage.set(results[i], [...(byMessage.get(results[i]) ?? []), file]);
	});
	if (byMessage.size === 0) return;
	const failed = [...byMessage.values()].flat().length;
	const lines = [...byMessage].map(
		([message, paths]) => `- ${listPaths(paths)}: ${indent(message.trimEnd())}`,
	);
	throw new Error(
		`Biome failed in ${failed} of ${files.length} file(s):\n${lines.join("\n")}`,
	);
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
 * The results of one shared biome check over a project's selected files.
 */
interface LintResults {
	/** The selected files, by workspace path, sorted. */
	files: string[];
	/** One result per file, named by its index in files: empty for a pass. */
	results: Directory;
}

/**
 * A file Biome checks, keyed by its workspace path.
 */
@object()
export class BiomeFile {
	/**
	 * File path, relative to the workspace.
	 */
	@func()
	path: string;

	constructor(path: string) {
		this.path = path;
	}

	/**
	 * Lint this file (`biome check`).
	 *
	 * Every selected file of a project shares one biome check of the project,
	 * which the engine runs once; each check reports only its own file.
	 *
	 * @param selection The files selected in this file's project. `dagger check` passes it, filtered by the active selection.
	 */
	@func()
	@check()
	async lint(ws: Workspace, selection: BiomeFiles): Promise<void> {
		const failure = await selection.failure(ws, this.path);
		if (failure !== "") throw new Error(`${this.path}: ${failure}`);
	}
}

/**
 * The files Biome checks in one project, keyed by workspace path.
 */
@collection()
export class BiomeFiles {
	/**
	 * File paths, relative to the workspace.
	 */
	@func()
	@keys()
	paths: string[];

	/**
	 * Files selected out since the collection was discovered.
	 */
	@func()
	@delta()
	delta?: CollectionDelta;

	/**
	 * Root of the project the files belong to, relative to the workspace.
	 */
	@func()
	project: string;

	baseImageAddress: string;

	packageManager: string;

	installFlags: string[];

	environment: string[];

	/** Why discovery failed, which every check of the project reports. */
	discoveryError: string;

	constructor(
		paths: string[],
		project: string,
		baseImageAddress: string,
		packageManager: string,
		installFlags: string[],
		environment: string[],
		discoveryError = "",
	) {
		this.paths = paths;
		this.project = project;
		this.baseImageAddress = baseImageAddress;
		this.packageManager = packageManager;
		this.installFlags = installFlags;
		this.environment = environment;
		this.discoveryError = discoveryError;
	}

	/**
	 * The file at path.
	 */
	@get()
	file(path: string): BiomeFile {
		return new BiomeFile(path);
	}

	/**
	 * Lint the selected files with one biome check, failing if any fails. Not
	 * a check: `dagger check` lints each file, sharing this same run.
	 */
	@func()
	async lint(ws: Workspace): Promise<void> {
		await this.raise(ws);
	}

	/** Raise naming every selected file that failed. */
	async raise(ws: Workspace, opts: { whole?: boolean } = {}): Promise<void> {
		if (this.paths.length === 0) return;
		const { files, results } = await this.results(ws, opts);
		const contents = await Promise.all(
			files.map((_, i) => results.file(String(i)).contents()),
		);
		await raiseFailures(files, contents);
	}

	/** Why the file at path failed, or "" when it passed. */
	async failure(ws: Workspace, path: string): Promise<string> {
		const { files, results } = await this.results(ws);
		const rank = files.indexOf(path);
		if (rank < 0) {
			throw new Error(`${path} is outside the lint selection`);
		}
		return results.file(String(rank)).contents();
	}

	/**
	 * Run biome check once for the selected files and index its report into
	 * one result per file.
	 *
	 * The command, its input and the indexer depend only on the selection, so
	 * every file check of the project builds the same ones and the engine runs
	 * them once. With nothing selected out it checks the whole project, as
	 * `biome check` does; otherwise it names the selected files. Without a
	 * delta, from a direct call, naming them is the safe choice.
	 */
	async results(
		ws: Workspace,
		opts: { whole?: boolean } = {},
	): Promise<LintResults> {
		if (this.discoveryError !== "") throw new Error(this.discoveryError);
		const files = sortedUnique(this.paths);
		if (files.length === 0) {
			throw new Error(`no files selected in project ${this.project}`);
		}
		let whole = opts.whole === true;
		if (!whole && this.delta) {
			const removed = await this.delta.removedKeys();
			whole = removed.length === 0;
		}
		const project = new BiomeProject(
			this.project,
			this.baseImageAddress,
			this.packageManager,
			this.installFlags,
			this.environment,
		);
		const { ctr, mount } = await project.runner(
			ws,
			await project.nestedRoots(ws),
		);
		const relative = files.map((f) => relativeTo(this.project, f));
		const executed = ctr.withExec(
			[BIOME, "check", ...LINT_FLAGS, ...(whole ? [] : relative)],
			{
				expect: ReturnType.Any,
				redirectStdout: LINT_STDOUT,
				redirectStderr: LINT_STDERR,
			},
		);
		const exitCode = await executed.exitCode();
		const selection = JSON.stringify({
			cwd: srcPath(relativeTo(mount, this.project)),
			files: relative,
			// Set with --error-on-warnings, when warnings fail the run too.
			failOnWarnings: false,
		});
		// Its own pinned container, whatever the base image: the project's
		// environment is Biome's, not the indexer's.
		const indexed = dag
			.container()
			.from(INDEXER_IMAGE)
			.withFile("/biome-report/stdout", executed.file(LINT_STDOUT))
			.withFile("/biome-report/stderr", executed.file(LINT_STDERR))
			.withNewFile("/biome-report/selection.json", selection)
			.withFile(
				"/biome-report/index.mjs",
				dag.currentModule().source().file("src/report-indexer.mjs"),
			)
			.withExec([
				"node",
				"/biome-report/index.mjs",
				"/biome-report/stdout",
				"/biome-report/stderr",
				"/biome-report/selection.json",
				String(exitCode),
				"/biome-results",
			]);
		return { files, results: indexed.directory("/biome-results") };
	}
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
	 * Files Biome checks in this project, keyed by workspace path.
	 *
	 * They are the files of the types Biome handles that its configuration
	 * includes, read from the source without running Biome: everything but
	 * node_modules, files ignored by .gitignore, nested root projects, and
	 * files another tool owns, such as package-lock.json.
	 */
	@func()
	async files(ws: Workspace): Promise<BiomeFiles> {
		let paths: string[];
		let discoveryError = "";
		try {
			paths = await this.discoverFiles(ws);
		} catch (err) {
			// The project fails alone, on its configuration file; listing and
			// every other project go on.
			const present = await ws
				.directory(absPath(this.path), { include: CONFIG_FILES })
				.entries()
				.catch(() => [] as string[]);
			const config =
				CONFIG_FILES.find((f) => present.includes(f)) ?? CONFIG_FILES[0];
			paths = [joinPath(this.path, config)];
			discoveryError = `${paths[0]}: finding the files of project ${this.path} failed: ${errorMessage(err)}`;
		}
		return new BiomeFiles(
			paths,
			this.path,
			this.baseImageAddress,
			this.packageManager,
			this.installFlags,
			this.environment,
			discoveryError,
		);
	}

	/**
	 * The project's files Biome checks, by workspace path, from file reads
	 * only: no container, no install, no Biome.
	 */
	async discoverFiles(ws: Workspace): Promise<string[]> {
		const nested = await this.nestedRoots(ws);
		const { install, source, mount } = await this.source(ws, nested);
		const projectDir = relativeTo(mount, this.path);
		const tree = source.directory(projectDir);
		const entries = (await tree.glob("**/*")).filter((p) => !p.endsWith("/"));
		const [configs, version] = await Promise.all([
			readConfigs(tree, entries),
			projectBiomeVersion(source, install, projectDir),
		]);
		return sortedUnique(
			entries
				.filter((f) => biomeChecks(configs, version, f))
				.map((f) => joinPath(this.path, f)),
		);
	}

	/**
	 * Lint the whole project with one biome check, failing if any file fails.
	 * Not a check: `dagger check` lints each file, sharing this same run.
	 */
	@func()
	async lint(ws: Workspace): Promise<void> {
		const files = await this.files(ws);
		await files.raise(ws, { whole: true });
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
		const ran = ctr.withExec([BIOME, "check", "--write", ...files], {
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
	async nestedRoots(ws: Workspace): Promise<string[]> {
		const dirs = (await configDirs(ws, this.path)).filter((d) =>
			isBelow(d, this.path),
		);
		const roots = await Promise.all(
			dirs.map(async (d) => ((await isRootDir(ws, d)) ? d : null)),
		);
		return roots.filter((d): d is string => d !== null);
	}

	/**
	 * The source biome runs on: the install root, or the project without one,
	 * without node_modules, nested root projects or files ignored by
	 * .gitignore. File discovery reads the same directory, so the two share
	 * one upload.
	 */
	async source(
		ws: Workspace,
		nested: string[],
	): Promise<{ install: Install | null; source: Directory; mount: string }> {
		const install = await findInstall(ws, this.path, this.packageManager);
		const mount = install?.root ?? this.path;
		const source = ws.directory(absPath(mount), {
			exclude: [
				"**/node_modules",
				...nested.map((sub) => relativeTo(mount, sub)),
			],
			gitignore: true,
		});
		return { install, source, mount };
	}

	/**
	 * Container that runs biome, with this project as the working directory.
	 * With a package.json at or above the project, the install root's
	 * dependencies are installed and the source laid over them, and the
	 * project's own Biome runs; otherwise npx fetches Biome on demand.
	 */
	async runner(ws: Workspace, nested: string[]): Promise<Runner> {
		const { install, source, mount } = await this.source(ws, nested);
		let ctr: Container;
		if (install === null) {
			ctr = nodeBase(this.baseImageAddress, "npm").withNewFile(
				BIOME,
				`#!/bin/sh\nexec npx --yes @biomejs/biome@${FALLBACK_BIOME_VERSION} "$@"\n`,
				{ permissions: 0o755 },
			);
		} else {
			ctr = (await this.installed(ws, install)).withNewFile(
				BIOME,
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
	 * Lint the selected Biome projects, each with one biome check. Not a
	 * check: `dagger check` lints each file of each project.
	 */
	@func()
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
