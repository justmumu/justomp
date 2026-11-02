/** Supply a boundary result immediately, while retaining Promise rejection for thrown errors. */
export function suppliedResponse<T>(read: () => T | PromiseLike<T>): Promise<T> {
  return new Promise((resolve) => resolve(read()));
}
