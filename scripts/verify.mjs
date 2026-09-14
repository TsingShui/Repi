/**
 * Starts the built site, runs the smoke check against it, then stops it.
 *
 * `npm run smoke` deliberately drives a server rather than owning one, so it can
 * point at a deployed build. That makes it easy to run with nothing listening,
 * which reads as a page full of failures instead of a missing server. This is the
 * one-command path.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const port = Number(process.env.REPI_PORT ?? 4173);
// `localhost` rather than 127.0.0.1: Vite preview listens on IPv6 loopback.
const url = `http://localhost:${port}/`;

function run(command, args, options = {}) {
  return spawn(command, args, { cwd: projectRoot, stdio: "inherit", ...options });
}

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
}

/*
 * Refuse to test against something that is already listening. Otherwise a server
 * left behind by an earlier run gets silently reused, and the check reports on a
 * build that may no longer exist.
 */
try {
  const existing = await fetch(url);
  if (existing.ok) {
    console.error(`Something is already serving ${url}.`);
    console.error(`Stop it first (pkill -f "vite preview"), or use REPI_PORT=<other> npm run verify`);
    process.exit(1);
  }
} catch {
  // Nothing listening, which is what we want.
}

// Detached, so the whole group can be killed: `npx` spawns `vite` as a child, and
// killing only the parent would orphan the server holding the port.
const server = run("npx", ["vite", "preview", "--port", String(port), "--strictPort"], {
  stdio: ["ignore", "ignore", "ignore"],
  detached: true,
});

let exitCode = 1;
try {
  if (!(await waitForServer())) {
    console.error(`Preview server never came up on ${url}`);
    process.exit(1);
  }

  exitCode = await new Promise((done) => {
    const smoke = run("node", ["./scripts/smoke.mjs"], {
      env: { ...process.env, REPI_SMOKE_URL: url },
    });
    smoke.on("exit", (code) => done(code ?? 1));
  });

  /*
   * The design document cites the smoke suite's assertion count. Checking it
   * straight after the run is what stops that number drifting — the alternative
   * is remembering to update prose by hand every time a check is added.
   */
  if (exitCode === 0) {
    exitCode = await new Promise((done) => {
      const doc = run("node", ["./docs/check-design-doc.mjs"]);
      doc.on("exit", (code) => done(code ?? 1));
    });
  }
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
}

process.exit(exitCode);
