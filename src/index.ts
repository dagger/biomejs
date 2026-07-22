/**
 * A BiomeJS toolchain to execute Biome on a JavaScript project.
 */

import {
  dag,
  Container,
  Directory,
  Workspace,
  object,
  func,
  check,
  Changeset,
} from "@dagger.io/dagger";

@object()
export class Biomejs {
  ws: Workspace;

  source: Directory;

  baseImageAddress: string;

  constructor(
    ws: Workspace,

    /**
     * The base image to use.
     *
     * This assume biome will run in a node container using npm
     * as package manager.
     */
    baseImageAddress: string = "node:25-alpine@sha256:f4769ca6eeb6ebbd15eb9c8233afed856e437b75f486f7fccaa81d7c8ad56007",
  ) {
    this.ws = ws;
    this.source = ws.directory("/");
    this.baseImageAddress = baseImageAddress;
  }

  /**
   * Path of the client's working directory, relative to the workspace root.
   */
  @func()
  async path(): Promise<string> {
    return this.ws.path();
  }

  /**
   * Lint the source code.
   *
   * @param files Files to lint, relative to the client's working directory.
   */
  @func()
  @check()
  async lint(files: string[] = []): Promise<void> {
    await (await this.base())
      .withWorkdir("/src/" + (await this.path()))
      .withExec(["npx", "@biomejs/biome", "check", ...files])
      .sync();
  }

  /**
   * Fix lint issue and return a changeset of the result.
   *
   * @param files Files to apply fix on, relative to the client's working directory.
   * @param fixFilter Patterns to select files to include in the changeset.
   */
  @func()
  async fix(
    files: string[] = [],
    fixFilter: string[] = ["**/*.js", "**/*.ts", "**/*.jsx", "**/*.tsx"],
  ): Promise<Changeset> {
    const fixed = (await this.base())
      .withWorkdir("/src/" + (await this.path()))
      .withExec(["npx", "@biomejs/biome", "check", "--write", ...files])
      .directory("/src")
      .withoutDirectory("node_modules");

    return dag
      .directory()
      .withDirectory(".", fixed, { include: fixFilter })
      .changes(
        dag.directory().withDirectory(".", this.source, { include: fixFilter }),
      );
  }

  async base(): Promise<Container> {
    let ctr = dag
      .container()
      .from(this.baseImageAddress)
      .withMountedCache("/root/.npm", dag.cacheVolume("node-modules"))
      .withDirectory("/src", this.source)
      .withWorkdir("/src")
      .withEnvVariable("CI", "true");

    // When the workspace root holds no package.json the dependency install is
    // skipped and npx fetches biome on demand, so a standalone biome config
    // works without a Node project.
    const hasPackageJson =
      (await this.source.glob("package.json")).length > 0;
    if (hasPackageJson) {
      ctr = ctr.withExec(["npm", "install"]);
    }
    return ctr;
  }
}
