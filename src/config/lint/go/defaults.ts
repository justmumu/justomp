import { type GoPolicy } from "../model";

export const GO_DEFAULTS: GoPolicy = {
  golangci: {
    severity: { default: "error" },
    linters: {
      default: "none",
      enable: [
        "govet",
        "staticcheck",
        "unused",
        "errcheck",
        "errorlint",
        "gosec",
        "bodyclose",
        "contextcheck",
        "exhaustive",
        "revive",
        "gocritic",
        "cyclop",
      ],
      settings: {
        errcheck: { "check-type-assertions": true, "check-blank": true },
        cyclop: { "max-complexity": 10 },
        exhaustive: { check: ["switch", "mapliteral"] },
      },
      exclusions: { generated: "strict", presets: [] },
    },
    formatters: {
      enable: ["gofumpt", "goimports"],
      exclusions: { generated: "strict" },
    },
  },
};
