import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catmPaths } from "../scripts/lib/catm-paths.mjs";

export function tempEnvironment(prefix = "catm-test-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const paths = catmPaths({ configHome: path.join(home, ".config"), dataHome: path.join(home, ".local", "share"), stateHome: path.join(home, ".local", "state") });
  return { root, home, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
