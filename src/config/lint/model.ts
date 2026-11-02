/** JSON configuration preserves unknown fields for future/native options. */
export interface PolicyObject {
  [key: string]: unknown;
}
export type RuleSeverity = "off" | "warn" | "error" | 0 | 1 | 2;
export type RuleSetting = RuleSeverity | [RuleSeverity, ...unknown[]];
export type RuleMap = Record<string, RuleSetting>;
export interface PythonPolicy extends PolicyObject {
  ruff: PolicyObject & {
    "line-length": number;
    exclude: string[];
    "extend-exclude": string[];
    lint: PolicyObject & {
      select: string[];
      ignore: string[];
      "per-file-ignores": Record<string, string[]>;
      isort: PolicyObject & { "combine-as-imports": boolean };
      pydocstyle: PolicyObject & { convention: string };
    };
    format: PolicyObject & {
      "quote-style": string;
      "indent-style": string;
      "skip-magic-trailing-comma": boolean;
      "line-ending": string;
    };
  };
}
export type BiomeRuleSeverity = "off" | "info" | "warn" | "error";
export type BiomeRuleSetting =
  | BiomeRuleSeverity
  | {
      level: BiomeRuleSeverity;
      options?: Record<string, unknown>;
      fix?: "none" | "safe" | "unsafe";
    };
export type BiomeRuleMap = Record<string, Record<string, BiomeRuleSetting>>;
export type BiomeAssistSetting =
  | "off"
  | "on"
  | {
      level: "off" | "on";
      options?: Record<string, unknown>;
    };
export interface JavascriptPolicy extends PolicyObject {
  exclude: string[];
  biome: PolicyObject & {
    globals: string[];
    rules: BiomeRuleMap;
    typed_rules: BiomeRuleMap;
    test_rules: BiomeRuleMap;
    react_rules: BiomeRuleMap;
    next_rules: BiomeRuleMap;
    organize_imports: BiomeAssistSetting;
  };
  prettier: PolicyObject & {
    printWidth: number;
    tabWidth: number;
    useTabs: boolean;
    semi: boolean;
    singleQuote: boolean;
    trailingComma: string;
    endOfLine: string;
  };
}
export interface GoPolicy extends PolicyObject {
  golangci: PolicyObject & {
    linters: PolicyObject & {
      default: string;
      enable: string[];
      settings: PolicyObject & {
        errcheck: PolicyObject & {
          "check-type-assertions": boolean;
          "check-blank": boolean;
        };
        cyclop: PolicyObject & { "max-complexity": number };
        exhaustive: PolicyObject & { check: string[] };
      };
      exclusions: PolicyObject & { generated: string; presets: string[] };
    };
    formatters: PolicyObject & {
      enable: string[];
      exclusions: PolicyObject & { generated: string };
    };
  };
}
export interface LintPolicy extends PolicyObject {
  python: PythonPolicy;
  javascript: JavascriptPolicy;
  go: GoPolicy;
}
