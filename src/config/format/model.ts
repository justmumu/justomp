import type { JavascriptPolicy, PolicyObject } from "../lint/model";
export interface FormatPolicy extends PolicyObject {
  include: string[];
  exclude: string[];
  prettier: JavascriptPolicy["prettier"];
}
