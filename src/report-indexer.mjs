// report-indexer reads the output of one shared `biome check --verbose` run
// and writes a bounded result for each selected file: empty when the file
// passed, otherwise why it failed. Every lint check of a project runs the
// same command and this same indexer, so the engine runs both once.
//
// Usage: node report-indexer.mjs STDOUT STDERR SELECTION EXIT_CODE OUTPUT
//
// SELECTION is JSON: {"cwd": "/src/app", "files": ["a.js", "src/b.ts"],
// "failOnWarnings": false}, with files relative to cwd, in the order whose
// indexes name the result files. failOnWarnings, for a run with
// --error-on-warnings, makes a warning fail its file as an error does.

import {
	createReadStream,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Output kept from the end of each stream, for failures without a file. */
const TAIL_LIMIT = 32 << 10;

/** Most diagnostics kept for one file, and the most any result holds. */
const RESULT_LIMIT = 96 << 10;

/**
 * A diagnostic header: an optional location, a category, optional tags such
 * as FIXABLE or VERBOSE, and a rule. For example:
 *
 *   src/a.js:1:1 lint/suspicious/noDebugger  FIXABLE  ━━━━━━━━━━
 *   data.json format ━━━━━━━━━━
 *   configuration ━━━━━━━━━━
 */
const HEADER =
	/^(?:(\S.*?)(?::\d+:\d+)? )?([A-Za-z][\w/.-]*)((?: +[A-Z][A-Z_]*)*) +━+\s*$/;

/** Categories of the summary Biome prints after errors it already listed. */
const SUMMARY_CATEGORIES = new Set(["check", "lint", "format", "ci"]);

class Tail {
	text = "";
	truncated = false;

	add(line) {
		this.text += `${line}\n`;
		if (this.text.length > TAIL_LIMIT) {
			this.text = this.text.slice(this.text.length - TAIL_LIMIT);
			this.truncated = true;
		}
	}

	toString() {
		return this.truncated
			? `[earlier output omitted]\n${this.text}`
			: this.text;
	}
}

class Head {
	text = "";
	truncated = false;

	add(block) {
		if (this.truncated) return;
		if (this.text.length + block.length > RESULT_LIMIT) {
			this.text += block.slice(0, Math.max(0, RESULT_LIMIT - this.text.length));
			this.truncated = true;
			return;
		}
		this.text += block;
	}

	toString() {
		return this.truncated
			? `${this.text}\n[remaining diagnostics omitted]\n`
			: this.text;
	}
}

function bound(text) {
	return text.length > RESULT_LIMIT
		? `${text.slice(0, RESULT_LIMIT)}\n[remaining diagnostics omitted]\n`
		: text;
}

/** Whether the first line of a diagnostic marks it as failing the run. */
function isFailure(line, failOnWarnings) {
	const mark = line.trim()[0];
	if (mark === "×" || mark === "✖") return true;
	return failOnWarnings && (mark === "!" || mark === "⚠");
}

async function summarize(stdoutPath, stderrPath, selection, exitCode) {
	const cwd = selection.cwd.replace(/\/+$/, "");
	const normalize = (path) => {
		let p = path.trim();
		if (p.startsWith(`${cwd}/`)) p = p.slice(cwd.length + 1);
		while (p.startsWith("./")) p = p.slice(2);
		return p;
	};
	const selected = new Set(selection.files);
	const failOnWarnings = selection.failOnWarnings === true;
	const processed = new Set();
	let processedListed = false;
	const fileErrors = new Map();
	const unattributed = [];
	const tails = { stdout: new Tail(), stderr: new Tail() };

	let block = null;
	const flush = () => {
		if (block === null) return;
		const { path, category, lines, error } = block;
		block = null;
		if (!error) return;
		const text = `${lines.join("\n").trimEnd()}\n\n`;
		if (path === null) {
			const summary =
				SUMMARY_CATEGORIES.has(category) &&
				/(errors|warnings) were emitted while/.test(text);
			if (!summary) unattributed.push(text);
			return;
		}
		if (!fileErrors.has(path)) fileErrors.set(path, new Head());
		fileErrors.get(path).add(text);
	};

	for (const [name, path] of [
		["stdout", stdoutPath],
		["stderr", stderrPath],
	]) {
		// A list is the lines "  - path" after a "Files processed:" or
		// "Files fixed:" heading, up to the next line that is not one.
		let list = null;
		const lines = createInterface({
			input: createReadStream(path, "utf8"),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		for await (const line of lines) {
			tails[name].add(line);
			if (list !== null) {
				const item = /^ {2}- (.+)$/.exec(line);
				if (item) {
					list.add(normalize(item[1]));
					continue;
				}
				if (line.trim() === "") continue;
				list = null;
			}
			if (/Files processed:\s*$/.test(line)) {
				flush();
				processedListed = true;
				list = processed;
				continue;
			}
			if (/Files fixed:\s*$/.test(line)) {
				flush();
				list = new Set();
				continue;
			}
			const header = line.startsWith(" ") ? null : HEADER.exec(line);
			if (header) {
				flush();
				block = {
					path: header[1] === undefined ? null : normalize(header[1]),
					category: header[2],
					lines: [line],
					error: null,
				};
				continue;
			}
			if (line.startsWith(" VERBOSE ")) {
				flush();
				continue;
			}
			if (block !== null) {
				block.lines.push(line);
				if (block.error === null && line.trim() !== "") {
					block.error = isFailure(line, failOnWarnings);
				}
			}
		}
		flush();
	}

	const output = `${tails.stdout}${tails.stderr}`.trim();
	let global = "";
	const unchecked = [...fileErrors.keys()].filter((p) => !selected.has(p));
	if (unattributed.length > 0) {
		// Such as a configuration error, which the diagnostics on the
		// configuration file explain.
		const files = [...fileErrors.values()].map(String).join("");
		global = `biome check failed (exit ${exitCode}):\n${files}${unattributed.join("")}`;
	} else if (unchecked.length > 0) {
		unchecked.sort();
		global = `biome check failed in files without a lint check: ${unchecked.join(", ")}\n\n${unchecked
			.map((p) => fileErrors.get(p).toString())
			.join("")}`;
	} else if (exitCode !== 0 && fileErrors.size === 0) {
		// The biome wrapper explains a missing Biome on its own.
		global =
			exitCode === 127
				? tails.stderr.toString().trim()
				: `biome check failed (exit ${exitCode}) without reporting a file:\n${output}`;
	}

	return selection.files.map((file) => {
		if (global !== "") return bound(global);
		const errors = fileErrors.get(file);
		if (errors !== undefined) {
			return bound(`biome check failed (exit ${exitCode}):\n${errors}`);
		}
		if (processed.has(file)) return "";
		if (processedListed) {
			// Discovery and Biome disagree: a pass here would have nothing
			// behind it.
			return `biome check did not process this file: Biome checked the project without it (its files.includes leaves it out, or this Biome version does not handle its file type)`;
		}
		return bound(
			`no result for this file: biome check exited ${exitCode} without listing the files it processed:\n${output}`,
		);
	});
}

async function main() {
	const [stdoutPath, stderrPath, selectionPath, exitCode, outputDir] =
		process.argv.slice(2);
	const selection = JSON.parse(readFileSync(selectionPath, "utf8"));
	const results = await summarize(
		stdoutPath,
		stderrPath,
		selection,
		Number(exitCode),
	);
	mkdirSync(outputDir, { recursive: true });
	results.forEach((result, i) => {
		writeFileSync(join(outputDir, String(i)), result);
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
