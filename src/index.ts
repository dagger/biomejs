/**
 * A BiomeJS toolchain to execute Biome on a JavaScript project.
 */

import {
	type Changeset,
	type Container,
	check,
	type Directory,
	dag,
	func,
	object,
	type Workspace,
} from "@dagger.io/dagger";
// TEST ONLY: sdk/index.ts does not re-export the collection decorators yet.
import { collection, get, keys } from "../sdk/core.js";

const DEFAULT_BASE_IMAGE =
	"node:25-alpine@sha256:f4769ca6eeb6ebbd15eb9c8233afed856e437b75f486f7fccaa81d7c8ad56007";

/** Biome configuration file names, in the order Biome prefers them. */
const CONFIG_FILES = ["biome.json", "biome.jsonc"];

/** Directories never searched for projects. */
const EXCLUDE = ["**/node_modules/**"];

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

/** Whether path is strictly below dir. */
function isBelow(path: string, dir: string): boolean {
	return path !== dir && (dir === "." || path.startsWith(`${dir}/`));
}

/** Absolute workspace path for a workspace-root-relative path. */
function absPath(path: string): string {
	return path === "." ? "/" : `/${path}`;
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

/**
 * Whether a Biome configuration is a project root. Biome v2 treats a
 * configuration as a root unless it sets `"root": false`.
 */
function isRootConfig(contents: string): boolean {
	const text = stripJsonc(contents);
	try {
		return JSON.parse(text)?.root !== false;
	} catch {
		return !/"root"\s*:\s*false/.test(text);
	}
}

/**
 * Whether the Biome configuration in dir (workspace-root-relative) is a root.
 * A directory without a readable configuration counts as a root.
 */
async function isRootDir(ws: Workspace, dir: string): Promise<boolean> {
	for (const name of CONFIG_FILES) {
		try {
			return isRootConfig(
				await ws.file(absPath(joinPath(dir, name))).contents(),
			);
		} catch {
			// Try the next configuration file name.
		}
	}
	return true;
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
 * Biome root projects at or below the workspace cwd, plus the one enclosing it.
 */
async function discoverProjects(ws: Workspace): Promise<string[]> {
	const dirs = await configDirs(ws, await cwdPath(ws));
	const roots = await Promise.all(dirs.map((d) => owningRoot(ws, d)));
	return [...new Set(roots)].sort();
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

	constructor(path: string, baseImageAddress: string) {
		this.path = path;
		this.baseImageAddress = baseImageAddress;
	}

	/**
	 * Lint this project.
	 */
	@func()
	@check()
	async lint(ws: Workspace): Promise<void> {
		await (await this.base(ws))
			.withExec(["npx", "@biomejs/biome", "check"])
			.sync();
	}

	/**
	 * Fix lint issues in this project and return the changes, rooted at the
	 * workspace root.
	 *
	 * @param files Files to fix, relative to the project root.
	 * @param fixFilter Patterns, relative to the project root, of files to include in the changeset.
	 */
	@func()
	async fix(
		ws: Workspace,
		files: string[] = [],
		fixFilter: string[] = ["**/*.js", "**/*.ts", "**/*.jsx", "**/*.tsx"],
	): Promise<Changeset> {
		const source = await this.source(ws);
		const fixed = (await this.base(ws, source))
			.withExec(["npx", "@biomejs/biome", "check", "--write", ...files])
			.directory(".");
		const at = (dir: Directory) =>
			dag.directory().withDirectory(this.path, dir, { include: fixFilter });
		return at(fixed).changes(at(source.directory(this.path)));
	}

	/**
	 * Other root projects nested in this one, relative to the workspace.
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
	 * The workspace, without node_modules or the nested root projects that
	 * Biome must not lint as part of this one.
	 */
	private async source(ws: Workspace): Promise<Directory> {
		const nested = await this.nestedRoots(ws);
		return ws.directory("/", {
			exclude: ["**/node_modules", ...nested],
		});
	}

	/**
	 * Node container with the workspace mounted at /src and the working
	 * directory at the project root.
	 */
	private async base(ws: Workspace, source?: Directory): Promise<Container> {
		let ctr = dag
			.container()
			.from(this.baseImageAddress)
			.withMountedCache("/root/.npm", dag.cacheVolume("node-modules"))
			.withDirectory("/src", source ?? (await this.source(ws)))
			.withEnvVariable("CI", "true");

		// Install dependencies from the nearest package.json at or above the
		// project. Without one, npx fetches Biome on demand, so a standalone
		// Biome configuration works without a Node project.
		const pkg = await ws.findUp("package.json", { from: absPath(this.path) });
		if (pkg) {
			const pkgDir = parentPath(joinPath(pkg)) ?? ".";
			ctr = ctr
				.withWorkdir(joinPath("/src", pkgDir))
				.withExec(["npm", "install"]);
		}
		return ctr.withWorkdir(joinPath("/src", this.path));
	}
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

	constructor(paths: string[], baseImageAddress: string) {
		this.paths = paths;
		this.baseImageAddress = baseImageAddress;
	}

	/**
	 * The Biome project rooted at path.
	 */
	@get()
	project(path: string): BiomeProject {
		return new BiomeProject(path, this.baseImageAddress);
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
				? [`- ${this.paths[i]}: ${errorMessage(r.reason)}`]
				: [],
		);
		if (failures.length > 0) {
			throw new Error(`Biome lint failed:\n${failures.join("\n")}`);
		}
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

@object()
export class Biomejs {
	baseImageAddress: string;

	constructor(
		/**
		 * The base image to use.
		 *
		 * This assume biome will run in a node container using npm
		 * as package manager.
		 */
		baseImageAddress: string = DEFAULT_BASE_IMAGE,
	) {
		this.baseImageAddress = baseImageAddress;
	}

	/**
	 * Biome projects at or below the working directory, keyed by project root.
	 */
	@func()
	async projects(ws: Workspace): Promise<BiomeProjects> {
		return new BiomeProjects(await discoverProjects(ws), this.baseImageAddress);
	}
}
