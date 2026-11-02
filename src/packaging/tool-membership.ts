/** Only newly discovered identities refresh a resolved tool target. */
export function toolMembership(previous: { projects: string[] } | undefined, projects: readonly string[]) {
  const live = [...new Set(projects)].sort();
  return {
    resolve: live.length > 0 && (!previous || live.some((id) => !previous.projects.includes(id))),
    projects: live,
    pending: [] as string[],
  };
}
