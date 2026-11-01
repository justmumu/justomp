export interface CommitPolicy extends Record<string, unknown> {
  header_max_length: number;
  types: string[];
  ignore_prefixes: string[];
}
