import { type ReleasePolicy } from "./model";
export const RELEASE_DEFAULTS: ReleasePolicy = {
  version_file: "VERSION",
  changelog_file: "CHANGELOG.md",
  remote: "origin",
  history_start: null,
};
