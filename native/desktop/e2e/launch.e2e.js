import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const fixtureBase64 =
  "UEFSMRUEFTAVMEwVBhUAEgAABwAAAAAAAAALAAAAAAAAAA0AAAAAAAAAFQAVCBUILBUGFRAVBhUGAAACAyQAFQQVHBUcTBUEFQASAAADAAAAQWRhAwAAAExpbhUAFRIVEiwVBhUQFQYVBgAAAgAAAAMFAQMCGRICGRgIBwAAAAAAAAAZGAgNAAAAAAAAABUCGRYAABkSAhkYA0FkYRkYA0xpbhUCGRYCKSYCBAAZHBZUFSoWAAAAGRwWtgEVNBYAABkWDAAVAhk8SAxhcnJvd19zY2hlbWEVBAAVBCUAGAJpZAAVDCUCGARuYW1lJQBMHAAAABYGGRwZLCYAHBUEGTUABhAZGAJpZBUAFgYWdhZ2JlQmCBwYCA0AAAAAAAAAGAgHAAAAAAAAABYAKAgNAAAAAAAAABgIBwAAAAAAAAAREQAZLBUEFQAVAgAVABUQFQIAABbaAhUUFuoBFT4AJgAcFQwZNQAGEBkYBG5hbWUVABYGFmwWbCa2ASZ+HDYCKANMaW4YA0FkYRERABksFQQVABUCABUAFRAVAgA8FgwpJgIEAAAW7gIVHBaoAhUyABbiARYGJggW4gEUAAAZHBgMQVJST1c6c2NoZW1hGIACLy8vLy83Z0FBQUFRQUFBQUFBQUtBQXdBQ2dBSkFBUUFDZ0FBQUJBQUFBQUFBUVFBQ0FBSUFBQUFCQUFJQUFBQUJBQUFBQUlBQUFCVUFBQUFGQUFBQUJBQUZBQVFBQTRBRHdBRUFBQUFDQUFRQUFBQUdBQUFBQXdBQUFBQUFBRUZFQUFBQUFBQUFBQUVBQVFBQkFBQUFBUUFBQUJ1WVcxbEFBQUFBQkFBRkFBUUFBQUFEd0FFQUFBQUNBQVFBQUFBR0FBQUFDQUFBQUFBQUFBQ0hBQUFBQWdBREFBRUFBc0FDQUFBQUVBQUFBQUFBQUFCQUFBQUFBSUFBQUJwWkFBQQAYGXBhcnF1ZXQtcnMgdmVyc2lvbiA1OC40LjAZLBwAABwAAAAxAgAAUEFSMQ==";

const driverHost = "127.0.0.1";
const driverPort = 4444;
const driverUrl = `http://${driverHost}:${driverPort}`;
const application = process.env.VIEWDA_BINARY
  ? path.resolve(process.env.VIEWDA_BINARY)
  : undefined;

if (!application) {
  throw new Error(
    "VIEWDA_BINARY must point to the downloaded Viewda executable.",
  );
}

await access(application);

const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "viewda-e2e-"));
const fixture = path.join(fixtureDirectory, "people.parquet");
await writeFile(fixture, Buffer.from(fixtureBase64, "base64"));
const configHome = path.join(fixtureDirectory, "config");
const tauriConfig = JSON.parse(
  await readFile(new URL("../tauri.conf.json", import.meta.url), "utf8"),
);
const appConfigDirectory = path.join(configHome, tauriConfig.identifier);
await mkdir(appConfigDirectory, { recursive: true });
await writeFile(
  path.join(appConfigDirectory, "recents.json"),
  JSON.stringify({
    nextId: 2,
    entries: [{ id: "recent-1", path: fixture }],
  }),
);

let sessionId;

async function waitForDriver() {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = net.createConnection(
        { host: driverHost, port: driverPort },
        () => {
          socket.end();
          resolve(true);
        },
      );

      socket.on("error", () => resolve(false));
    });

    if (ready) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("tauri-driver did not start within 15 seconds.");
}

async function webdriver(method, endpoint, body) {
  const response = await fetch(`${driverUrl}${endpoint}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();

  if (!response.ok || payload.value?.error) {
    throw new Error(
      `WebDriver ${method} ${endpoint} failed: ${JSON.stringify(payload.value)}`,
    );
  }

  return payload.value;
}

async function inspectElement(selector) {
  // WebKitGTK can return an empty WebDriver element/text for visible Tauri
  // content, so read through the same driver and assert visibility explicitly.
  return webdriver("POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const element = document.querySelector(arguments[0]);
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        text: element.innerText,
        visible:
          style.display !== "none" &&
          style.visibility === "visible" &&
          Number(style.opacity) > 0 &&
          rect.width > 0 &&
          rect.height > 0,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    `,
    args: [selector],
  });
}

async function waitForText(selector, expected) {
  const deadline = Date.now() + 15_000;
  let observed = null;

  while (Date.now() < deadline) {
    try {
      observed = await inspectElement(selector);
      if (observed?.visible && expected.test(observed.text)) {
        return observed.text;
      }
    } catch {
      // The React shell can still be mounting while the native window is ready.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const diagnostics = await webdriver(
    "POST",
    `/session/${sessionId}/execute/sync`,
    {
      script: `return {
        readyState: document.readyState,
        bodyText: document.body?.innerText ?? null,
        scripts: Array.from(document.scripts, ({ src }) => src),
      };`,
      args: [],
    },
  ).catch((error) => ({ diagnosticError: String(error) }));

  throw new Error(
    `Timed out waiting for visible ${selector}; last observed state: ${JSON.stringify(observed)}; page: ${JSON.stringify(diagnostics)}`,
  );
}

async function inspectGridCell(columnName, rowIndex) {
  return webdriver("POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const canvas = document.querySelector('[data-testid="data-grid-canvas"]');
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const grid = canvas.querySelector('[role="grid"]');
      const header = Array.from(grid?.querySelectorAll('[role="columnheader"]') ?? [])
        .find((element) => element instanceof HTMLElement && element.innerText === arguments[0]);
      if (!(header instanceof HTMLElement)) return null;
      const columnIndex = header.getAttribute('aria-colindex');
      const row = grid.querySelector('[role="row"][aria-rowindex="' + (arguments[1] + 2) + '"]');
      const cell = row?.querySelector('[role="gridcell"][aria-colindex="' + columnIndex + '"]');
      if (!(cell instanceof HTMLElement)) return null;
      const style = getComputedStyle(canvas);
      const rect = canvas.getBoundingClientRect();
      return {
        text: cell.innerText,
        visible:
          style.display !== "none" &&
          style.visibility === "visible" &&
          Number(style.opacity) > 0 &&
          rect.width > 0 &&
          rect.height > 0,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    `,
    args: [columnName, rowIndex],
  });
}

async function waitForGridCell(columnName, rowIndex, expected) {
  const deadline = Date.now() + 15_000;
  let observed = null;

  while (Date.now() < deadline) {
    observed = await inspectGridCell(columnName, rowIndex).catch(() => null);
    if (observed?.visible && expected.test(observed.text)) {
      return observed.text;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for grid cell ${columnName}[${rowIndex}]; last observed state: ${JSON.stringify(observed)}`,
  );
}

async function runSession(assertions) {
  const environment = { ...process.env };
  environment.XDG_CONFIG_HOME = configHome;
  const driver = spawn("tauri-driver", [], {
    env: environment,
    stdio: ["ignore", "inherit", "inherit"],
  });

  try {
    await waitForDriver();
    const session = await webdriver("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          "tauri:options": {
            application,
          },
        },
      },
    });
    sessionId = session.sessionId;
    await assertions();
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => {});
      sessionId = undefined;
    }
    driver.kill("SIGTERM");
    if (driver.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => driver.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (driver.exitCode === null) {
        driver.kill("SIGKILL");
      }
    }
  }
}

try {
  await runSession(async () => {
    const title = await webdriver("GET", `/session/${sessionId}/title`);
    assert.equal(title, "Viewda");
    await waitForText(".file-context", /^No file open$/);
    await waitForText(".open-button", /^Open Parquet file…$/);
    await waitForText(
      ".empty-message",
      /^Your data never leaves this machine\.$/,
    );
    await waitForText(
      '[aria-label="Keyboard shortcuts"]',
      /Open file\s+Ctrl\+O\s+Settings\s+Ctrl\+,/,
    );

    await waitForText(".recent-file-name", /^people\.parquet$/);
    const clickedRecent = await webdriver(
      "POST",
      `/session/${sessionId}/execute/sync`,
      {
        script: `
          const button = document.querySelector('.recent-files button');
          if (!(button instanceof HTMLButtonElement)) return false;
          button.click();
          return true;
        `,
        args: [],
      },
    );
    assert.equal(clickedRecent, true);
    await waitForText(".file-context", /^people\.parquet$/);
    await waitForGridCell("name", 0, /^Ada$/);
  });

  process.stdout.write(
    "Downloaded Viewda artifact preserved its empty state and rendered a known Parquet cell.\n",
  );
} finally {
  await rm(fixtureDirectory, { recursive: true, force: true });
}
