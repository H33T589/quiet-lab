import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ChatSession,
  createSessionId,
  deleteSession,
  getSessionSnapshot,
  listAvailableModels,
  listSessionSummaries,
  normalizeSessionId,
  saveSessionAs,
  sessionsDir,
} from "./engine.mjs";
import {
  clearProjectMemory,
  loadProjectMemory,
  setProjectUserNotes,
} from "./memory.mjs";
import { listPresets } from "./presets.mjs";
import { resolvePublicFilePath } from "./public-static.mjs";
import {
  attachCodebase,
  configureTooling,
  getToolRuntimeConfig,
  getWorkspaceSnapshot,
  hiddenPaths,
  listToolCatalog,
  listRepoEntries,
  listTools,
  loadWorkspaceState,
  readRepoText,
  resourceBudgets,
  toolProfiles,
} from "./tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const defaultHost = process.env.OLLAMA_CHAT_HOST || "127.0.0.1";
const defaultPort = Number.parseInt(process.env.OLLAMA_CHAT_PORT || "4317", 10);
const defaultModel = process.env.OLLAMA_MODEL || "llama3.2:3b";
const execFileAsync = promisify(execFile);
const maxJsonBodyBytes = 1_000_000;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendNotFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function sendMethodNotAllowed(res) {
  sendJson(res, 405, { error: "Method not allowed" });
}

function sendBadRequest(res, message) {
  sendJson(res, 400, { error: message });
}

export async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.byteLength;

    if (totalBytes > maxJsonBodyBytes) {
      throw new HttpError(413, "Request body is too large.");
    }

    chunks.push(buffer);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function getSessionRouteParts(urlPathname) {
  const parts = urlPathname.split("/").filter(Boolean);
  const sessionId = decodeURIComponent(parts[2] || "");
  const action = parts[3] || null;
  return { action, sessionId };
}

function parseSessionId(value) {
  return normalizeSessionId(value);
}

async function getSession(sessionId) {
  const session = new ChatSession({ sessionId: parseSessionId(sessionId) });
  const loaded = await session.load();

  if (!loaded) {
    await session.save();
  }

  return session;
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function isAllowedHost(hostHeader, allowedHost = defaultHost) {
  const rawHost = String(hostHeader || "").toLowerCase();
  const hostname = rawHost.startsWith("[")
    ? rawHost.slice(1, rawHost.indexOf("]"))
    : rawHost.replace(/:\d+$/, "");
  const allowed = new Set(["127.0.0.1", "localhost", "::1"]);

  if (allowedHost && allowedHost !== "0.0.0.0" && allowedHost !== "::") {
    allowed.add(allowedHost.toLowerCase());
  }

  return allowed.has(hostname);
}

export function isAllowedOrigin(originHeader, allowedHost = defaultHost) {
  if (!originHeader) {
    return true;
  }

  try {
    const origin = new URL(originHeader);
    return isAllowedHost(origin.host, allowedHost);
  } catch {
    return false;
  }
}

export function assertRequestAllowed(req, allowedHost = defaultHost) {
  if (!isAllowedHost(req.headers.host, allowedHost)) {
    throw new HttpError(403, "Host is not allowed.");
  }

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "") &&
    !isAllowedOrigin(req.headers.origin, allowedHost)
  ) {
    throw new HttpError(403, "Origin is not allowed.");
  }
}

async function pickWorkspaceDirectory() {
  const platform = os.platform();

  if (platform === "darwin") {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Choose a repository folder for quiet-lab")',
    ]);
    return stdout.trim();
  }

  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Choose a repository folder for quiet-lab'",
      "$dialog.ShowNewFolderButton = $false",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  Write-Output $dialog.SelectedPath",
      "} else {",
      "  exit 1",
      "}",
    ].join("; ");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-Command",
      script,
    ]);
    return stdout.trim();
  }

  try {
    const { stdout } = await execFileAsync("zenity", [
      "--file-selection",
      "--directory",
      "--title=Choose a repository folder for quiet-lab",
    ]);
    return stdout.trim();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const { stdout } = await execFileAsync("kdialog", [
    "--getexistingdirectory",
    os.homedir(),
    "--title",
    "Choose a repository folder for quiet-lab",
  ]);
  return stdout.trim();
}

async function handleMeta(_req, res) {
  const [sessions, models] = await Promise.all([
    listSessionSummaries(),
    listAvailableModels(),
  ]);

  sendJson(res, 200, {
    defaultModel,
    hiddenPaths,
    ollamaReachable: models.length > 0,
    models: models.length ? models : [defaultModel],
    presets: listPresets(),
    repoName: getWorkspaceSnapshot().repoName,
    workspace: getWorkspaceSnapshot({ includeRecent: true }),
    sessions,
    toolConfig: getToolRuntimeConfig(),
    toolProfiles,
    resourceBudgets,
    tools: listTools()
      .split("\n")
      .map((line) => {
        const [name, ...rest] = line.split(": ");
        return { name, description: rest.join(": ") };
      }),
  });
}

async function handleWorkspace(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, getWorkspaceSnapshot({ includeRecent: true }));
    return;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return;
  }

  const body = await readJsonBody(req);

  try {
    sendJson(res, 200, await attachCodebase(body.path));
  } catch (error) {
    sendBadRequest(res, error.message);
  }
}

async function handleWorkspacePick(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return;
  }

  try {
    const selectedPath = await pickWorkspaceDirectory();

    if (!selectedPath) {
      sendBadRequest(res, "No folder was selected.");
      return;
    }

    sendJson(res, 200, await attachCodebase(selectedPath));
  } catch (error) {
    const message = error?.code === "ENOENT"
      ? "No native folder picker is available. Paste a folder path instead."
      : os.platform() === "darwin"
        ? "Finder folder picker was cancelled or blocked. Allow automation permissions for your terminal, or paste a folder path instead."
        : "Folder picker was cancelled or could not open. Paste a folder path instead.";
    sendBadRequest(res, message);
  }
}

async function handleTooling(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, {
      config: getToolRuntimeConfig(),
      profiles: toolProfiles,
      budgets: resourceBudgets,
      tools: listToolCatalog(),
    });
    return;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return;
  }

  const body = await readJsonBody(req);
  sendJson(res, 200, {
    config: configureTooling(body),
    profiles: toolProfiles,
    budgets: resourceBudgets,
    tools: listToolCatalog(),
  });
}

async function handleMemory(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, { memory: await loadProjectMemory() });
    return;
  }

  if (req.method === "DELETE") {
    sendJson(res, 200, { memory: await clearProjectMemory() });
    return;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return;
  }

  const body = await readJsonBody(req);
  sendJson(res, 200, { memory: await setProjectUserNotes(body.userNotes || []) });
}

async function handleSessions(_req, res) {
  sendJson(res, 200, { sessions: await listSessionSummaries() });
}

async function handleCreateSession(req, res) {
  const body = await readJsonBody(req);
  let sessionId;

  try {
    sessionId = body.sessionId ? parseSessionId(body.sessionId) : createSessionId();
  } catch (error) {
    sendBadRequest(res, error.message);
    return;
  }

  const session = new ChatSession({
    sessionId,
    model: body.model || defaultModel,
    preset: body.preset || "coder",
  });

  if (body.customPresetPrompt) {
    await session.setCustomPreset(body.preset || "custom", body.customPresetPrompt, {
      resetHistory: true,
    });
  }

  await session.save();
  sendJson(res, 201, {
    session: session.toJSON(),
    sessions: await listSessionSummaries(),
  });
}

async function handleSessionById(req, res, pathname) {
  const { action, sessionId: rawSessionId } = getSessionRouteParts(pathname);

  if (!rawSessionId) {
    sendNotFound(res);
    return;
  }

  let sessionId;

  try {
    sessionId = parseSessionId(rawSessionId);
  } catch (error) {
    sendBadRequest(res, error.message);
    return;
  }

  if (req.method === "GET" && !action) {
    sendJson(res, 200, { session: await getSessionSnapshot(sessionId) });
    return;
  }

  if (req.method === "DELETE" && !action) {
    await deleteSession(sessionId);
    sendJson(res, 200, {
      sessions: await listSessionSummaries(),
    });
    return;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return;
  }

  const body = await readJsonBody(req);
  const session = await getSession(sessionId);

  if (action === "reset") {
    await session.reset();
    sendJson(res, 200, {
      session: session.toJSON(),
      sessions: await listSessionSummaries(),
    });
    return;
  }

  if (action === "config") {
    if (body.model) {
      await session.setModel(body.model);
    }

    if (body.customPresetPrompt) {
      await session.setCustomPreset(body.preset || "custom", body.customPresetPrompt, {
        resetHistory: body.resetHistory !== false,
      });
    } else if (body.preset) {
      await session.setPreset(body.preset, { resetHistory: body.resetHistory !== false });
    }

    sendJson(res, 200, {
      session: session.toJSON(),
      sessions: await listSessionSummaries(),
    });
    return;
  }

  if (action === "save") {
    const savedSession = await saveSessionAs(sessionId, body.title);
    sendJson(res, 201, {
      session: savedSession,
      sessions: await listSessionSummaries(),
    });
    return;
  }

  sendNotFound(res);
}

async function handleChatStream(req, res) {
  const body = await readJsonBody(req);
  let sessionId;

  try {
    sessionId = parseSessionId(body.sessionId || "latest");
  } catch (error) {
    sendBadRequest(res, error.message);
    return;
  }

  const message = String(body.message || "").trim();

  if (!message) {
    sendJson(res, 400, { error: "Message is required." });
    return;
  }

  const session = await getSession(sessionId);

  if (body.model && body.model !== session.model) {
    await session.setModel(body.model);
  }

  if (body.preset && body.preset !== session.activePreset) {
    await session.setPreset(body.preset, { resetHistory: body.resetHistory !== false });
  }

  res.writeHead(200, {
    ...securityHeaders,
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
  });

  sendEvent(res, "session", {
    sessionId: session.sessionId,
    model: session.model,
    preset: session.activePreset,
  });

  try {
    await session.chat(message, {
      onToken(token) {
        sendEvent(res, "token", { token });
      },
      onToolCall(call) {
        sendEvent(res, "tool_call", {
          name: call.function.name,
          arguments: call.function.arguments || {},
        });
      },
      onToolResult({ call, result }) {
        sendEvent(res, "tool_result", {
          name: call.function.name,
          result,
        });
      },
      onFinal(text) {
        sendEvent(res, "done", {
          text,
          session: session.toJSON(),
        });
      },
    });
  } catch (error) {
    sendEvent(res, "error", { message: error.message });
  } finally {
    res.end();
  }
}

async function handleRepoTree(req, res, url) {
  const result = await listRepoEntries({
    path: url.searchParams.get("path") || ".",
    depth: Number.parseInt(url.searchParams.get("depth") || "2", 10),
    max_entries: Number.parseInt(url.searchParams.get("maxEntries") || "120", 10),
  });

  sendJson(res, result.status === "OK" ? 200 : 400, result);
}

async function handleRepoFile(req, res, url) {
  const result = await readRepoText({
    path: url.searchParams.get("path"),
    start_line: Number.parseInt(url.searchParams.get("start") || "1", 10),
    end_line: Number.parseInt(url.searchParams.get("end") || "220", 10),
  });

  sendJson(res, result.status === "OK" ? 200 : 400, result);
}

async function serveStatic(res, pathname) {
  const filePath = resolvePublicFilePath(publicDir, pathname);

  if (!filePath) {
    sendNotFound(res);
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendNotFound(res);
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      ...securityHeaders,
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendNotFound(res);
  }
}

export function createQuietLabServer({ host = defaultHost } = {}) {
  return http.createServer(async (req, res) => {
    try {
      assertRequestAllowed(req, host);
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      const pathname = url.pathname;

      if (pathname === "/api/meta" && req.method === "GET") {
        await handleMeta(req, res);
        return;
      }

      if (pathname === "/api/workspace/pick") {
        await handleWorkspacePick(req, res);
        return;
      }

      if (pathname === "/api/workspace") {
        await handleWorkspace(req, res);
        return;
      }

      if (pathname === "/api/tooling") {
        await handleTooling(req, res);
        return;
      }

      if (pathname === "/api/memory") {
        await handleMemory(req, res);
        return;
      }

      if (pathname === "/api/sessions" && req.method === "GET") {
        await handleSessions(req, res);
        return;
      }

      if (pathname === "/api/sessions" && req.method === "POST") {
        await handleCreateSession(req, res);
        return;
      }

      if (pathname.startsWith("/api/sessions/")) {
        await handleSessionById(req, res, pathname);
        return;
      }

      if (pathname === "/api/chat/stream" && req.method === "POST") {
        await handleChatStream(req, res);
        return;
      }

      if (pathname === "/api/repo/tree" && req.method === "GET") {
        await handleRepoTree(req, res, url);
        return;
      }

      if (pathname === "/api/repo/file" && req.method === "GET") {
        await handleRepoFile(req, res, url);
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendNotFound(res);
        return;
      }

      await serveStatic(res, pathname);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "Internal server error" });
    }
  });
}

export async function startQuietLabServer({ host = defaultHost, port = defaultPort } = {}) {
  await mkdir(sessionsDir, { recursive: true });
  await loadWorkspaceState();

  const server = createQuietLabServer({ host });

  await new Promise((resolve) => {
    server.listen(port, host, resolve);
  });

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startQuietLabServer();
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : defaultPort;

  console.log(`quiet-lab UI listening on http://${defaultHost}:${activePort}`);
}
