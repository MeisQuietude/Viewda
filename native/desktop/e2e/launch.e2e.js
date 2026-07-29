import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

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

const driver = spawn("tauri-driver", [], {
  stdio: ["ignore", "inherit", "inherit"],
});
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

  process.stdout.write(
    "Downloaded Viewda artifact launched and reached the Rust data engine.\n",
  );
} finally {
  if (sessionId) {
    await webdriver("DELETE", `/session/${sessionId}`).catch(() => {});
  }
  driver.kill("SIGTERM");
}
