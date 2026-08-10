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
      const viewport = document.querySelector('[data-testid="regular-table-grid"]');
      if (!(viewport instanceof HTMLElement)) return null;
      const header = Array.from(viewport.querySelectorAll('[role="columnheader"]'))
        .find((element) =>
          element instanceof HTMLElement &&
          element.querySelector('.viewda-grid-header-label')?.textContent === arguments[0]
        );
      if (!(header instanceof HTMLElement)) return null;
      const columnIndex = header.getAttribute('aria-colindex');
      const row = viewport.querySelector('[role="row"][aria-rowindex="' + (arguments[1] + 2) + '"]');
      const cell = row?.querySelector('[role="gridcell"][aria-colindex="' + columnIndex + '"]');
      if (!(cell instanceof HTMLElement)) return null;
      const style = getComputedStyle(viewport);
      const rect = viewport.getBoundingClientRect();
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

async function inspectSubCellScroll(columnName) {
  return webdriver("POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      const viewport = document.querySelector('[data-testid="regular-table-grid"]');
      if (!(viewport instanceof HTMLElement) || typeof viewport.draw !== 'function') {
        done(null);
        return;
      }
      const findColumn = () => {
        const header = Array.from(viewport.querySelectorAll('[role="columnheader"]'))
          .find((element) =>
            element instanceof HTMLElement &&
            element.querySelector('.viewda-grid-header-label')?.textContent === arguments[0]
          );
        if (!(header instanceof HTMLElement)) return null;
        const columnIndex = header.getAttribute('aria-colindex');
        const cell = viewport.querySelector(
          '[role="gridcell"][aria-colindex="' + columnIndex + '"][aria-rowindex="2"]'
        );
        const markerHeader = viewport.querySelector(
          '[role="columnheader"][aria-colindex="1"]'
        );
        const markerCell = viewport.querySelector(
          '[role="rowheader"][aria-rowindex="2"]'
        );
        return cell instanceof HTMLElement &&
          markerHeader instanceof HTMLElement &&
          markerCell instanceof HTMLElement
          ? { header, cell, markerHeader, markerCell }
          : null;
      };
      (async () => {
        viewport.style.right = 'auto';
        viewport.style.width = '180px';
        await viewport.draw({ invalid_viewport: true });
        await viewport.flush();
        const samples = [];
        for (const offset of [0, 4, 8, 40, 80, 88, 96]) {
          viewport.scrollLeft = offset;
          viewport.dispatchEvent(new Event('scroll'));
          await new Promise(requestAnimationFrame);
          await viewport.flush();
          const column = findColumn();
          if (column === null) {
            done(null);
            return;
          }
          samples.push({
            offset: viewport.scrollLeft,
            headerX: column.header.getBoundingClientRect().x,
            cellX: column.cell.getBoundingClientRect().x,
            markerHeaderX: column.markerHeader.getBoundingClientRect().x,
            markerCellX: column.markerCell.getBoundingClientRect().x,
          });
        }
        viewport.scrollLeft = viewport.scrollWidth;
        viewport.dispatchEvent(new Event('scroll'));
        await new Promise(requestAnimationFrame);
        await viewport.flush();
        const viewportRect = viewport.getBoundingClientRect();
        const dataHeaders = Array.from(
          viewport.querySelectorAll('[role="columnheader"]')
        ).filter((element) =>
          element instanceof HTMLElement &&
          !element.classList.contains('viewda-grid-row-marker') &&
          getComputedStyle(element).display !== 'none'
        );
        done({
          samples,
          rightEdge: {
            scrollLeft: viewport.scrollLeft,
            viewportRight: viewportRect.left + viewport.clientWidth,
            rightmostHeader: Math.max(
              ...dataHeaders.map((header) => header.getBoundingClientRect().right)
            ),
          },
        });
      })().catch((error) => done({ error: String(error) }));
    `,
    args: [columnName],
  });
}

async function selectGridCell(columnName, rowIndex) {
  return webdriver("POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const viewport = document.querySelector('[data-testid="regular-table-grid"]');
      if (!(viewport instanceof HTMLElement)) return null;
      const header = Array.from(viewport.querySelectorAll('[role="columnheader"]'))
        .find((element) =>
          element instanceof HTMLElement &&
          element.querySelector('.viewda-grid-header-label')?.textContent === arguments[0]
        );
      if (!(header instanceof HTMLElement)) return null;
      const columnIndex = header.getAttribute('aria-colindex');
      const cell = viewport.querySelector(
        '[role="gridcell"][aria-colindex="' + columnIndex + '"][aria-rowindex="' +
          (arguments[1] + 2) + '"]'
      );
      if (!(cell instanceof HTMLElement)) return null;
      const rect = cell.getBoundingClientRect();
      cell.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: rect.left + 2,
        clientY: rect.top + 2,
      }));
      viewport.focus({ preventScroll: true });
      return {
        active: document.activeElement === viewport,
        rowIndex: cell.getAttribute('aria-rowindex'),
      };
    `,
    args: [columnName, rowIndex],
  });
}

async function sendKeys(actions) {
  await webdriver("POST", `/session/${sessionId}/actions`, {
    actions: [{ type: "key", id: "keyboard", actions }],
  });
}

async function sendShortcut(key) {
  const control = "\uE009";
  await sendKeys([
    { type: "keyDown", value: control },
    { type: "keyDown", value: key },
    { type: "keyUp", value: key },
    { type: "keyUp", value: control },
  ]);
}

async function inspectClipboardCopy(columnName, rowIndex) {
  const selected = await selectGridCell(columnName, rowIndex);
  if (!selected?.active) return null;
  await sendShortcut("c");

  const deadline = Date.now() + 5_000;
  let pasted = null;
  while (Date.now() < deadline) {
    await webdriver("POST", `/session/${sessionId}/execute/sync`, {
      script: `
        let target = document.querySelector('#viewda-e2e-paste-target');
        if (!(target instanceof HTMLElement)) {
          target = document.createElement('div');
          target.id = 'viewda-e2e-paste-target';
          target.contentEditable = 'true';
          target.style.position = 'fixed';
          target.style.left = '0';
          target.style.top = '0';
          document.body.append(target);
        }
        target.replaceChildren();
        target.focus();
      `,
      args: [],
    });
    await sendShortcut("v");
    pasted = await webdriver("POST", `/session/${sessionId}/execute/sync`, {
      script: `
        const target = document.querySelector('#viewda-e2e-paste-target');
        return target instanceof HTMLElement
          ? { text: target.textContent, html: target.innerHTML }
          : null;
      `,
      args: [],
    });
    if (pasted?.text === "Ada" && /<table[\s>]/i.test(pasted.html)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await webdriver("POST", `/session/${sessionId}/execute/sync`, {
    script: `document.querySelector('#viewda-e2e-paste-target')?.remove();`,
    args: [],
  });
  return { selected, pasted };
}

async function inspectEnterNavigation(columnName, rowIndex) {
  const before = await selectGridCell(columnName, rowIndex);
  if (!before?.active) return null;
  await sendKeys([
    { type: "keyDown", value: "\uE007" },
    { type: "keyUp", value: "\uE007" },
  ]);
  const after = await webdriver("POST", `/session/${sessionId}/execute/sync`, {
    script: `
        const viewport = document.querySelector('[data-testid="regular-table-grid"]');
        if (!(viewport instanceof HTMLElement)) return null;
        const active = viewport.getAttribute('aria-activedescendant');
        const cell = active === null ? null : document.getElementById(active);
        return cell?.getAttribute('aria-rowindex') ?? null;
      `,
    args: [],
  });
  return { before: before.rowIndex, after };
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
    const clipboard = await inspectClipboardCopy("name", 0);
    assert.ok(clipboard, "Expected the selected cell to own keyboard copy");
    assert.equal(clipboard.pasted?.text, "Ada");
    assert.match(
      clipboard.pasted?.html ?? "",
      /<table[\s>]/i,
      `Clipboard lost its HTML table flavor: ${JSON.stringify(clipboard)}`,
    );
    const enter = await inspectEnterNavigation("id", 0);
    assert.deepEqual(enter, { before: "2", after: "3" });
    const scroll = await inspectSubCellScroll("name");
    assert.ok(scroll, "Expected measurable regular-table cells");
    assert.equal(scroll.error, undefined);
    const [firstScroll, ...laterScrolls] = scroll.samples;
    assert.ok(firstScroll, "Expected an initial horizontal scroll sample");
    assert.equal(scroll.samples.at(-1)?.offset, 96);
    for (const sample of laterScrolls) {
      assert.ok(
        Math.abs(sample.headerX - firstScroll.headerX + sample.offset) < 0.75,
        `Header jumped during horizontal scroll: ${JSON.stringify(scroll)}`,
      );
      assert.ok(
        Math.abs(sample.cellX - firstScroll.cellX + sample.offset) < 0.75,
        `Cell jumped during horizontal scroll: ${JSON.stringify(scroll)}`,
      );
      assert.ok(
        Math.abs(sample.markerHeaderX - firstScroll.markerHeaderX) < 0.75 &&
          Math.abs(sample.markerCellX - firstScroll.markerCellX) < 0.75,
        `Row markers moved during horizontal scroll: ${JSON.stringify(scroll)}`,
      );
    }
    assert.ok(scroll.rightEdge, "Expected a measurable horizontal right edge");
    assert.ok(scroll.rightEdge.scrollLeft > 0);
    assert.ok(
      Math.abs(
        scroll.rightEdge.rightmostHeader - scroll.rightEdge.viewportRight,
      ) < 0.75,
      `Horizontal scroll left a blank tail: ${JSON.stringify(scroll)}`,
    );
  });

  process.stdout.write(
    "Downloaded Viewda artifact preserved its empty state, rendered a known Parquet cell, scrolled by sub-cell pixels, copied rich data, and moved down on Enter.\n",
  );
} finally {
  await rm(fixtureDirectory, { recursive: true, force: true });
}
