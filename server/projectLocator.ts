import { existsSync } from "node:fs";
import path from "node:path";

const projectMarker = path.join("ProjectSettings", "ProjectVersion.txt");

/** Walks up from `startDirectory` and returns the first Unity project root, or null. */
export function findUnityProjectRoot(startDirectory: string | null | undefined): string | null {
  if (!startDirectory) {
    return null;
  }

  let current = path.resolve(startDirectory);
  while (true) {
    const markerPath = path.join(current, projectMarker);
    const isProjectRoot = existsSync(markerPath);
    if (isProjectRoot) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
