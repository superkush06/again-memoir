import type { HumanBodyShape } from "../neural-asset-validation";

export type BodyShapeChoice = HumanBodyShape | "photo-fit";

/** Swap complete sets atomically: loading a comparison must not remove the
 * current bodies, resurrect a closed scene, or let a slower old choice win. */
export function createBodyShapeController<T extends { dispose(): void }>(
  initial: T[],
  build: (index: number, choice: BodyShapeChoice) => Promise<T>,
  install: (next: T[], previous: T[]) => void,
) {
  let current = [...initial];
  let revision = 0;
  let disposed = false;
  return {
    async select(choice: BodyShapeChoice) {
      if (disposed) return false;
      const request = ++revision;
      const results = await Promise.allSettled(
        current.map((_, i) => Promise.resolve().then(() => build(i, choice))),
      );
      const next = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const failure = results.find((result) => result.status === "rejected");
      if (disposed || request !== revision || failure) {
        next.forEach((body) => body.dispose());
        if (!disposed && request === revision && failure?.status === "rejected")
          throw failure.reason;
        return false;
      }
      const previous = current;
      try {
        install(next, previous);
      } catch (error) {
        // A renderer callback can fail after attaching some of the new meshes.
        // Restore ownership before disposing the rejected comparison.
        try {
          install(previous, next);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Body shape installation and restoration failed");
        } finally {
          next.forEach((body) => body.dispose());
        }
        throw error;
      }
      current = next;
      previous.forEach((body) => body.dispose());
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      current.forEach((body) => body.dispose());
    },
  };
}
