import { type AdapterContext, type ProcessResult } from "../../dependencies/model";
import { lintManagerContext } from "../../lint/runtime";
import { type TypecheckTarget } from "../targets";
import { typescriptRun } from "./native";

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

  async showConfig(target: TypecheckTarget, args: string[]): Promise<ProcessResult> {
    this.signal.throwIfAborted();
    const command = ["--showConfig", ...args];
    const native = await this.native(target);
    const result = await typescriptRun(target, command, this.signal, native);
    this.signal.throwIfAborted();
    return { ...result };
  }
}
