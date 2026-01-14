/**
 * A BiomeJS toolchain to execute Biome on a JavaScript project.
 */

import {
  dag,
  Container,
  Directory,
  object,
  func,
  argument,
  check,
  Changeset,
} from "@dagger.io/dagger";

@object()
export class Biomejs {
  source: Directory;

  baseImageAddress: string;

  constructor(
    /**
     * The source directory of the project.
     */
    @argument({ defaultPath: "/" })
    source: Directory,

    /**
     * The base image to use.
     *
     * This assume biome will run in a node container using npm
     * as package manager.
     */
    baseImageAddress: string = "node:25-alpine@sha256:f4769ca6eeb6ebbd15eb9c8233afed856e437b75f486f7fccaa81d7c8ad56007",
  ) {
    this.source = source;
    this.baseImageAddress = baseImageAddress;
  }

  /**
   * Lint the source code.
   *
   * @param files Files to lint.
   */
  @func()
  @check()
  async lint(files: string[] = []): Promise<void> {
    await this.base()
      .withExec(["npx", "@biomejs/biome", "check", ...files])
      .sync();
  }

  /**
   * Fix lint issue and return a changeset of the result.
   *
   * @param files Files to apply fix on.
   * @param fixFilter Patterns to select files to include in the changeset.
   */
  @func()
  async fix(
    files: string[] = [],
    fixFilter: string[] = ["**/*.js", "**/*.ts", "**/*.jsx", "**/*.tsx"],
  ): Promise<Changeset> {
    const fixed = this.base()
      .withExec(["npx", "@biomejs/biome", "check", "--write", ...files])
      .directory(".")
      .withoutDirectory("node_modules");

    return dag
      .directory()
      .withDirectory(".", fixed, { include: fixFilter })
      .changes(
        dag.directory().withDirectory(".", this.source, { include: fixFilter }),
      );
  }

  base(): Container {
    return dag
      .container()
      .from(this.baseImageAddress)
      .withMountedCache("/root/.npm", dag.cacheVolume("node-modules"))
      .withDirectory("/src", this.source)
      .withWorkdir("/src")
      .withEnvVariable("CI", "true")
      .withExec(["npm", "install"]);
  }
}
