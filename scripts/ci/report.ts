import { readManagedGateReports } from "../test-cost-report";

export const CI_STAGES = ["install", "check", "integration"] as const;

export interface GitChange {
  status: string;
  path: string;
  from?: string;
}
export interface DriftObservation {
  stage: string;
  head: string;
  changes: GitChange[];
}

/** Porcelain -z keeps whitespace and quoting out of the path protocol. */
export function parseGitStatus(text: string): GitChange[] {
  if (!text) {
    return [];
  }
  if (!text.endsWith("\0")) {
    throw new Error("Incomplete Git status output");
  }
  const entries = text.slice(0, -1).split("\0");
  const changes: GitChange[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const { status, path } = parseEntry(entries[index]);
    if (/[RC]/.test(status)) {
      const from = entries[++index];
      if (!from) {
        throw new Error("Missing Git rename source");
      }
      changes.push({ status, path, from });
    } else {
      changes.push({ status, path });
    }
  }
  return changes;
}

export function summarizeCi(
  outcomes: Record<string, string>,
  head: string,
  observations: DriftObservation[],
  check: unknown,
  integration: unknown,
) {
  const errors = executionErrors(outcomes, observations);
  for (const observation of observations) {
    errors.push(...observationErrors(head, observation));
  }
  let gate: ReturnType<typeof readManagedGateReports> | undefined;
  try {
    gate = readManagedGateReports(check, integration);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { success: errors.length === 0, head, outcomes, observations, gate, errors };
}

function parseEntry(entry: string | undefined): GitChange {
  if (!entry || entry.length < 4 || entry[2] !== " ") {
    throw new Error("Invalid Git status entry");
  }
  return { status: entry.slice(0, 2), path: entry.slice(3) };
}

function executionErrors(outcomes: Record<string, string>, observations: DriftObservation[]): string[] {
  const errors: string[] = [];
  for (const stage of CI_STAGES) {
    if (outcomes[stage] !== "success") {
      errors.push(`${stage}: process outcome ${outcomes[stage] ?? "missing"}`);
    }
    if (!observations.some((observation) => observation.stage === stage)) {
      errors.push(`Missing ${stage} checkout observation`);
    }
  }
  return errors;
}

function observationErrors(head: string, observation: DriftObservation): string[] {
  const errors = observation.head === head ? [] : [`${observation.stage}: checkout revision changed`];
  return [
    ...errors,
    ...observation.changes.map((change) => `${observation.stage}: ${change.status} ${JSON.stringify(change.path)}`),
  ];
}
