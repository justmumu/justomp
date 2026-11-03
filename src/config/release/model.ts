export interface ReleasePolicy extends Record<string, unknown> {
  version_file: string;
  changelog_file: string;
  remote: string;
  history_start: string | null;
}
