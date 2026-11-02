import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AdapterContext, type ProcessResult } from "../../dependencies/model";
import { lintManagerContext } from "../../lint/runtime";
import { type TypecheckTarget } from "../targets";
import { assertTypecheckNative, typescriptRun } from "./native";

/** One read-only config traversal. Never retain across writes or verification phases. */
export class JavascriptConfigRead {
  private readonly managers = new WeakMap<TypecheckTarget, Promise<AdapterContext>>();
  constructor(private readonly signal: AbortSignal) {}

  async native(target: TypecheckTarget): Promise<AdapterContext> {
    this.signal.throwIfAborted();
    let pending = this.managers.get(target);
    if (!pending) {
      pending = lintManagerContext(target, this.signal);
      this.managers.set(target, pending);
    }
    try {
      const result = await pending;
      this.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (this.managers.get(target) === pending) {
        this.managers.delete(target);
      }
      throw error;
    }
  }

  /** Resolve imports without emitting or publishing a config into the project. */
  async programFiles(
    target: TypecheckTarget,
    args: string[],
    files: string[],
    references: string[],
  ): Promise<string[]> {
    this.signal.throwIfAborted();
    if (!files.length) {
      return [];
    }
    const temporary = await mkdtemp(join(tmpdir(), "justomp-declaration-inputs-"));
    try {
      const config = join(temporary, "tsconfig.json");
      const projectIndex = args.lastIndexOf("--project") + 1;
      await writeFile(
        config,
        JSON.stringify({
          extends: args[projectIndex],
          files,
          include: [],
          exclude: [],
          references: references.map((path) => ({ path })),
        }),
      );
      const command = [...args, "--listFilesOnly"];
      command[projectIndex] = config;
      const result = await typescriptRun(target, command, this.signal, await this.native(target));
      this.signal.throwIfAborted();
      assertTypecheckNative(result, "Resolve declaration source imports");
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((path) => resolve(target.scope.cwd, path));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async showConfig(target: TypecheckTarget, args: string[]): Promise<ProcessResult> {
    this.signal.throwIfAborted();
    const command = ["--showConfig", ...args];
    const native = await this.native(target);
    const result = await typescriptRun(target, command, this.signal, native);
    this.signal.throwIfAborted();
    return { ...result };
  }
}
