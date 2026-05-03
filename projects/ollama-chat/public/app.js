const state = {
  currentFile: null,
  currentRepoPath: ".",
  currentSessionId: null,
  deleteSessionTarget: null,
  filePreview: null,
  messages: [],
  meta: null,
  model: null,
  preset: null,
  repoEntries: [],
  repoFilter: "",
  sessions: [],
  sending: false,
  statusText: "Loading workspace...",
  statusTone: "neutral",
  toolEvents: [],
  workspace: {
    attached: false,
    recentCodebases: [],
    repoName: null,
  },
};

const elements = {
  attachCodebaseButton: document.querySelector("#attach-codebase-button"),
  attachDialog: document.querySelector("#attach-dialog"),
  attachDialogCancel: document.querySelector("#attach-dialog-cancel"),
  attachDialogClose: document.querySelector("#attach-dialog-close"),
  attachDialogForm: document.querySelector("#attach-dialog-form"),
  attachDialogInput: document.querySelector("#attach-dialog-input"),
  chatLog: document.querySelector("#chat-log"),
  clearToolsButton: document.querySelector("#clear-tools-button"),
  composerForm: document.querySelector("#composer-form"),
  composerInput: document.querySelector("#composer-input"),
  deleteDialog: document.querySelector("#delete-dialog"),
  deleteDialogCancel: document.querySelector("#delete-dialog-cancel"),
  deleteDialogClose: document.querySelector("#delete-dialog-close"),
  deleteDialogConfirm: document.querySelector("#delete-dialog-confirm"),
  deleteDialogCopy: document.querySelector("#delete-dialog-copy"),
  filePreview: document.querySelector("#file-preview"),
  filePreviewTitle: document.querySelector("#file-preview-title"),
  messageTemplate: document.querySelector("#message-template"),
  modelSelect: document.querySelector("#model-select"),
  newSessionButton: document.querySelector("#new-session-button"),
  presetSelect: document.querySelector("#preset-select"),
  quickPromptButtons: document.querySelectorAll(".quick-prompts button"),
  repoBreadcrumbs: document.querySelector("#repo-breadcrumbs"),
  repoFilterInput: document.querySelector("#repo-filter-input"),
  repoRootButton: document.querySelector("#repo-root-button"),
  repoTree: document.querySelector("#repo-tree"),
  recentCodebases: document.querySelector("#recent-codebases"),
  resetSessionButton: document.querySelector("#reset-session-button"),
  saveDialog: document.querySelector("#save-dialog"),
  saveDialogCancel: document.querySelector("#save-dialog-cancel"),
  saveDialogClose: document.querySelector("#save-dialog-close"),
  saveDialogForm: document.querySelector("#save-dialog-form"),
  saveDialogInput: document.querySelector("#save-dialog-input"),
  saveSessionButton: document.querySelector("#save-session-button"),
  selectedFileButton: document.querySelector("#selected-file-button"),
  sendButton: document.querySelector("#send-button"),
  sessionList: document.querySelector("#session-list"),
  sessionStats: document.querySelector("#session-stats"),
  sessionTitle: document.querySelector("#session-title"),
  statusBanner: document.querySelector("#status-banner"),
  statusText: document.querySelector("#status-text"),
  toolEvents: document.querySelector("#tool-events"),
  workspaceTitle: document.querySelector("#workspace-title"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMarkdown(input) {
  let html = escapeHtml(input);

  html = html.replace(/```([\s\S]*?)```/g, (_match, code) => {
    return `<pre>${escapeHtml(code.trim())}</pre>`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, "<br />")}</p>`)
    .join("");

  return html;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Request failed");
  }

  return response.json();
}

function setStatus(text, tone = "neutral") {
  state.statusText = text;
  state.statusTone = tone;
}

function getSessionTitle(session) {
  return session?.title || session?.sessionId || "New session";
}

function getVisibleMessages() {
  return state.messages.filter((message) => message.role !== "system" && message.role !== "tool");
}

function formatRelativeTime(value) {
  if (!value) {
    return "not saved";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "not saved";
  }

  const deltaSeconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));

  if (deltaSeconds < 60) {
    return "just now";
  }

  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function setSessionState(session) {
  state.currentSessionId = session.sessionId;
  state.messages = session.messages || [];
  state.model = session.model;
  state.preset = session.preset;
  elements.sessionTitle.textContent = getSessionTitle(session);
}

function renderStatus() {
  elements.statusBanner.className = `status-banner ${state.statusTone}`;
  elements.statusText.textContent = state.statusText;
}

function renderSessionStats() {
  const activeSession = state.sessions.find((session) => session.sessionId === state.currentSessionId);
  const stats = [
    `${getVisibleMessages().length} messages`,
    state.model || state.meta?.defaultModel || "no model",
    state.preset || "coder",
    formatRelativeTime(activeSession?.updatedAt),
  ];

  elements.sessionStats.innerHTML = stats
    .map((item) => `<span>${escapeHtml(item)}</span>`)
    .join("");
}

function renderSessions() {
  elements.sessionList.innerHTML = "";

  if (!state.sessions.length) {
    elements.sessionList.innerHTML = `<p class="empty-state">No saved sessions yet.</p>`;
    return;
  }

  for (const session of state.sessions) {
    const card = document.createElement("article");
    card.className = `session-card${session.sessionId === state.currentSessionId ? " active" : ""}`;
    card.innerHTML = `
      <button class="session-open-button" type="button">
        <h4>${escapeHtml(session.title || session.sessionId)}</h4>
        <p>${escapeHtml(session.preset || "coder")} · ${escapeHtml(session.model || state.meta?.defaultModel || "")} · ${escapeHtml(formatRelativeTime(session.updatedAt))}</p>
      </button>
      <button class="session-delete-button" type="button" aria-label="Delete ${escapeHtml(session.title || session.sessionId)}">×</button>
    `;
    const openButton = card.querySelector(".session-open-button");
    const deleteButton = card.querySelector(".session-delete-button");
    openButton.disabled = state.sending;
    deleteButton.disabled = state.sending;
    openButton.addEventListener("click", () => loadSession(session.sessionId));
    deleteButton.addEventListener("click", () => openDeleteDialog(session));
    elements.sessionList.append(card);
  }
}

function renderMessages() {
  elements.chatLog.innerHTML = "";

  if (!state.messages.length) {
    elements.chatLog.innerHTML = `<p class="empty-state">Start with a repo question, a code prompt, or a brainstorming ask.</p>`;
    return;
  }

  for (const message of state.messages) {
    if (message.role === "system" || message.role === "tool") {
      continue;
    }

    const node = elements.messageTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(message.role);
    node.querySelector(".message-meta").textContent = message.role;
    node.querySelector(".message-body").innerHTML = renderMarkdown(message.content || "");
    elements.chatLog.append(node);
  }

  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
}

function renderToolEvents() {
  elements.toolEvents.innerHTML = "";

  if (!state.toolEvents.length) {
    elements.toolEvents.innerHTML = `<p class="empty-state">Tool calls will show up here during repo-aware turns.</p>`;
    return;
  }

  for (const event of state.toolEvents.slice(-8).reverse()) {
    const card = document.createElement("article");
    card.className = "tool-card";
    card.innerHTML = `
      <strong>${escapeHtml(event.name)}</strong>
      <p>${escapeHtml(event.summary)}</p>
    `;
    elements.toolEvents.append(card);
  }
}

function renderRepoTree() {
  elements.repoTree.innerHTML = "";

  if (!state.workspace.attached) {
    elements.repoTree.innerHTML = `
      <div class="repo-empty-state">
        <p>No codebase attached.</p>
        <button class="primary-button" type="button" data-open-attach>Attach Codebase</button>
      </div>
    `;
    elements.repoTree.querySelector("[data-open-attach]")?.addEventListener("click", openAttachDialog);
    return;
  }

  const query = state.repoFilter.trim().toLowerCase();
  const entries = query
    ? state.repoEntries.filter((entry) =>
        `${entry.name} ${entry.path}`.toLowerCase().includes(query),
      )
    : state.repoEntries;

  if (!entries.length) {
    elements.repoTree.innerHTML = `<p class="empty-state">${
      state.repoEntries.length ? "No matches in this folder." : "No repo entries loaded."
    }</p>`;
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `repo-entry ${entry.kind}`;
    row.innerHTML = `
      <strong>${escapeHtml(entry.name)}</strong>
      <p>${escapeHtml(entry.path)}</p>
    `;
    row.addEventListener("click", () => {
      if (entry.kind === "directory") {
        loadRepoTree(entry.path);
      } else {
        loadRepoFile(entry.path);
      }
    });
    elements.repoTree.append(row);
  }
}

function renderBreadcrumbs() {
  elements.repoBreadcrumbs.innerHTML = "";

  if (!state.workspace.attached) {
    return;
  }

  const segments = state.currentRepoPath === "." ? [] : state.currentRepoPath.split("/");
  const crumbs = [{ label: "root", path: "." }];

  segments.reduce((current, segment) => {
    const next = current === "." ? segment : `${current}/${segment}`;
    crumbs.push({ label: segment, path: next });
    return next;
  }, ".");

  for (const crumb of crumbs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "crumb";
    button.textContent = crumb.label;
    button.addEventListener("click", () => loadRepoTree(crumb.path));
    elements.repoBreadcrumbs.append(button);
  }
}

function renderFilePreview() {
  elements.filePreviewTitle.textContent = state.currentFile || "Select a file";
  elements.filePreview.textContent =
    state.filePreview ||
    (state.workspace.attached
      ? "Select a repository file to preview it here with line numbers."
      : "Attach a codebase to preview files here.");
  elements.selectedFileButton.disabled = !state.currentFile;
}

function renderWorkspace() {
  elements.workspaceTitle.textContent = state.workspace.attached
    ? state.workspace.repoName
    : "No codebase";
  elements.attachCodebaseButton.textContent = state.workspace.attached
    ? "Switch Codebase"
    : "Attach Codebase";
}

function syncControls() {
  elements.modelSelect.value = state.model || state.meta?.defaultModel || "";
  elements.presetSelect.value = state.preset || "coder";
  const sendDisabled = state.sending || !state.currentSessionId;

  elements.composerInput.disabled = sendDisabled;
  elements.modelSelect.disabled = state.sending;
  elements.newSessionButton.disabled = state.sending;
  elements.presetSelect.disabled = state.sending;
  elements.repoFilterInput.disabled = state.sending || !state.workspace.attached;
  elements.repoRootButton.disabled = state.sending || !state.workspace.attached;
  elements.resetSessionButton.disabled = state.sending || !state.currentSessionId;
  elements.saveSessionButton.disabled = state.sending || !state.currentSessionId || getVisibleMessages().length === 0;
  elements.selectedFileButton.disabled = state.sending || !state.currentFile;
  elements.sendButton.disabled = sendDisabled;
  elements.sendButton.textContent = state.sending ? "Sending..." : "Send";
  for (const button of elements.quickPromptButtons) {
    button.disabled = state.sending;
  }
}

function render() {
  renderWorkspace();
  renderStatus();
  renderSessionStats();
  renderSessions();
  renderMessages();
  renderToolEvents();
  renderRepoTree();
  renderBreadcrumbs();
  renderFilePreview();
  syncControls();
}

function renderRecentCodebases() {
  const recent = state.workspace.recentCodebases || [];

  if (!recent.length) {
    elements.recentCodebases.innerHTML = "";
    return;
  }

  elements.recentCodebases.innerHTML = `
    <p class="dialog-label">Recent</p>
    <div class="recent-codebase-list"></div>
  `;
  const list = elements.recentCodebases.querySelector(".recent-codebase-list");

  for (const recentPath of recent) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-codebase";
    button.textContent = recentPath;
    button.addEventListener("click", () => {
      elements.attachDialogInput.value = recentPath;
      attachSelectedCodebase(recentPath).catch((error) => {
        setStatus(error.message, "error");
        render();
      });
    });
    list.append(button);
  }
}

async function loadMeta() {
  state.meta = await fetchJson("/api/meta");
  state.sessions = state.meta.sessions;
  state.model = state.meta.defaultModel;
  state.preset = "coder";
  state.workspace = {
    ...state.workspace,
    ...(state.meta.workspace || {}),
  };

  if (state.meta.ollamaReachable) {
    setStatus("Workspace ready.", "success");
  } else {
    setStatus("Ollama is offline. Start it on http://127.0.0.1:11434 to send messages.", "error");
  }

  elements.modelSelect.innerHTML = state.meta.models
    .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
    .join("");
  elements.presetSelect.innerHTML = state.meta.presets
    .map((preset) => `<option value="${escapeHtml(preset)}">${escapeHtml(preset)}</option>`)
    .join("");
}

async function loadWorkspace() {
  state.workspace = await fetchJson("/api/workspace");
}

async function loadSessions() {
  const payload = await fetchJson("/api/sessions");
  state.sessions = payload.sessions;
  renderSessions();
}

async function loadSession(sessionId) {
  const payload = await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
  setSessionState(payload.session);
  render();
}

async function createSession() {
  const payload = await fetchJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      model: state.model,
      preset: state.preset,
    }),
  });

  state.sessions = payload.sessions;
  state.toolEvents = [];
  setStatus("New session ready.", "success");
  await loadSession(payload.session.sessionId);
}

function openAttachDialog() {
  elements.attachDialogInput.value = "";
  renderRecentCodebases();
  elements.attachDialog.hidden = false;
  elements.attachDialogInput.focus();
}

function closeAttachDialog() {
  elements.attachDialog.hidden = true;
}

async function attachSelectedCodebase(inputPath) {
  const payload = await fetchJson("/api/workspace", {
    method: "POST",
    body: JSON.stringify({ path: inputPath }),
  });

  state.workspace = payload;
  state.currentFile = null;
  state.filePreview = null;
  state.repoEntries = [];
  state.repoFilter = "";
  state.currentRepoPath = ".";
  state.toolEvents = [];
  elements.repoFilterInput.value = "";
  await createSession();
  await loadRepoTree(".");
  closeAttachDialog();
  setStatus(`Attached ${payload.repoName}.`, "success");
  render();
}

async function resetSession() {
  if (!state.currentSessionId) {
    return;
  }

  const payload = await fetchJson(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/reset`, {
    method: "POST",
    body: JSON.stringify({}),
  });

  state.sessions = payload.sessions;
  setSessionState(payload.session);
  state.toolEvents = [];
  setStatus("Session reset.", "neutral");
  render();
}

function getDefaultSaveTitle() {
  const currentTitle = elements.sessionTitle.textContent || "";
  return currentTitle === "New session" ? "" : currentTitle;
}

function openSaveDialog() {
  if (!state.currentSessionId) {
    return;
  }

  elements.saveDialogInput.value = getDefaultSaveTitle();
  elements.saveDialog.hidden = false;
  elements.saveDialogInput.focus();
  elements.saveDialogInput.select();
}

function closeSaveDialog() {
  elements.saveDialog.hidden = true;
}

async function saveConversation(title) {
  if (!state.currentSessionId) {
    return;
  }

  const cleanTitle = String(title || "").trim();

  if (!cleanTitle) {
    setStatus("Conversation name is required.", "error");
    render();
    return;
  }

  const payload = await fetchJson(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/save`, {
    method: "POST",
    body: JSON.stringify({ title: cleanTitle }),
  });

  state.sessions = payload.sessions;
  state.toolEvents = [];
  setStatus(`Saved conversation as ${payload.session.title}.`, "success");
  await loadSession(payload.session.sessionId);
}

function openDeleteDialog(session) {
  state.deleteSessionTarget = session;
  const title = session.title || session.sessionId;
  elements.deleteDialogCopy.textContent = `Delete "${title}"? This removes the local saved chat file from sessions.`;
  elements.deleteDialog.hidden = false;
  elements.deleteDialogConfirm.focus();
}

function closeDeleteDialog() {
  state.deleteSessionTarget = null;
  elements.deleteDialog.hidden = true;
}

async function deleteSelectedSession() {
  const session = state.deleteSessionTarget;

  if (!session) {
    return;
  }

  const title = session.title || session.sessionId;
  const payload = await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}`, {
    method: "DELETE",
  });
  state.sessions = payload.sessions;
  setStatus(`Deleted ${title}.`, "neutral");
  closeDeleteDialog();

  if (session.sessionId === state.currentSessionId) {
    state.toolEvents = [];

    if (state.sessions.length) {
      await loadSession(state.sessions[0].sessionId);
    } else {
      await createSession();
    }
    return;
  }

  render();
}

async function updateConfig() {
  if (!state.currentSessionId) {
    return;
  }

  const payload = await fetchJson(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/config`, {
    method: "POST",
    body: JSON.stringify({
      model: state.model,
      preset: state.preset,
      resetHistory: true,
    }),
  });

  state.sessions = payload.sessions;
  setSessionState(payload.session);
  state.toolEvents = [];
  setStatus(`Using ${state.preset} preset with ${state.model}.`, "success");
  render();
}

async function loadRepoTree(targetPath = ".") {
  if (!state.workspace.attached) {
    state.repoEntries = [];
    state.currentRepoPath = ".";
    render();
    return;
  }

  const payload = await fetchJson(
    `/api/repo/tree?path=${encodeURIComponent(targetPath)}&depth=1&maxEntries=120`,
  );
  state.currentRepoPath = payload.path;
  state.repoEntries = payload.entries || [];
  state.repoFilter = "";
  elements.repoFilterInput.value = "";
  render();
}

async function loadRepoFile(targetPath) {
  if (!state.workspace.attached) {
    setStatus("Attach a codebase first.", "error");
    render();
    return;
  }

  const payload = await fetchJson(
    `/api/repo/file?path=${encodeURIComponent(targetPath)}&start=1&end=220`,
  );
  state.currentFile = payload.path;
  state.filePreview = payload.numberedLines
    .map((line) => `${String(line.number).padStart(4, " ")}  ${line.text}`)
    .join("\n");
  setStatus(`Opened ${payload.path}.`, "neutral");
  render();
}

function appendComposerText(text) {
  const current = elements.composerInput.value.trimEnd();
  elements.composerInput.value = current ? `${current}\n${text}` : text;
  elements.composerInput.focus();
}

function addAssistantPlaceholder() {
  const assistant = { role: "assistant", content: "" };
  state.messages.push(assistant);
  renderMessages();
  return assistant;
}

async function streamChat(message) {
  const userMessage = { role: "user", content: message };
  state.messages.push(userMessage);
  const assistant = addAssistantPlaceholder();
  state.sending = true;
  setStatus("Sending message...", "busy");
  render();

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        model: state.model,
        preset: state.preset,
        resetHistory: false,
        sessionId: state.currentSessionId,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error("Chat request failed.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "message";
    let currentData = "";

    function flushEvent() {
      if (!currentData) {
        return;
      }

      const payload = JSON.parse(currentData);

      if (currentEvent === "session") {
        state.currentSessionId = payload.sessionId || state.currentSessionId;
        state.model = payload.model || state.model;
        state.preset = payload.preset || state.preset;
        setStatus("Generating reply...", "busy");
      }

      if (currentEvent === "token") {
        assistant.content += payload.token;
        renderMessages();
      }

      if (currentEvent === "tool_call") {
        state.toolEvents.push({
          name: payload.name,
          summary: JSON.stringify(payload.arguments || {}),
        });
        setStatus(`Running ${payload.name}...`, "busy");
        renderToolEvents();
      }

      if (currentEvent === "tool_result") {
        state.toolEvents.push({
          name: payload.name,
          summary: payload.result.slice(0, 180),
        });
        renderToolEvents();
      }

      if (currentEvent === "done") {
        assistant.content = payload.text || assistant.content;
        if (payload.session) {
          setSessionState(payload.session);
        }
        if (state.meta) {
          state.meta.ollamaReachable = true;
        }
        setStatus("Reply complete.", "success");
        renderMessages();
      }

      if (currentEvent === "error") {
        throw new Error(payload.message);
      }
    }

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n");
      buffer = chunks.pop() || "";

      for (const line of chunks) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
          continue;
        }

        if (line.startsWith("data: ")) {
          currentData = line.slice(6);
          continue;
        }

        if (!line.trim()) {
          flushEvent();
          currentEvent = "message";
          currentData = "";
        }
      }
    }

    await loadSessions();
    await loadSession(state.currentSessionId);
  } catch (error) {
    assistant.content = `Error: ${error.message}`;

    if (state.meta && /Could not reach Ollama/i.test(error.message)) {
      state.meta.ollamaReachable = false;
      setStatus("Ollama is offline. Start it on http://127.0.0.1:11434 to send messages.", "error");
    } else {
      setStatus(error.message, "error");
    }

    renderMessages();
  } finally {
    state.sending = false;
    render();
  }
}

async function init() {
  await loadMeta();
  await loadWorkspace();

  if (!state.sessions.length) {
    await createSession();
  } else {
    await loadSession(state.sessions[0].sessionId);
  }

  if (state.workspace.attached) {
    await loadRepoTree(".");
  }

  render();
}

elements.newSessionButton.addEventListener("click", () => {
  createSession().catch((error) => {
    setStatus(error.message, "error");
    render();
  });
});

elements.attachCodebaseButton.addEventListener("click", openAttachDialog);

elements.repoRootButton.addEventListener("click", () => {
  loadRepoTree(".").catch((error) => {
    setStatus(error.message, "error");
    render();
  });
});

elements.attachDialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  attachSelectedCodebase(elements.attachDialogInput.value).catch((error) => {
    setStatus(error.message, "error");
    render();
  });
});

elements.attachDialogCancel.addEventListener("click", closeAttachDialog);
elements.attachDialogClose.addEventListener("click", closeAttachDialog);
elements.attachDialog.addEventListener("click", (event) => {
  if (event.target === elements.attachDialog) {
    closeAttachDialog();
  }
});

elements.repoFilterInput.addEventListener("input", (event) => {
  state.repoFilter = event.target.value;
  renderRepoTree();
});

elements.clearToolsButton.addEventListener("click", () => {
  state.toolEvents = [];
  setStatus("Tool activity cleared.", "neutral");
  render();
});

elements.selectedFileButton.addEventListener("click", () => {
  if (!state.currentFile) {
    return;
  }

  appendComposerText(`\`${state.currentFile}\``);
  setStatus("Path added.", "neutral");
  renderStatus();
});

elements.resetSessionButton.addEventListener("click", () => {
  resetSession().catch((error) => {
    setStatus(error.message, "error");
    render();
  });
});

elements.saveSessionButton.addEventListener("click", () => {
  openSaveDialog();
});

elements.saveDialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveConversation(elements.saveDialogInput.value)
    .then(closeSaveDialog)
    .catch((error) => {
      setStatus(error.message, "error");
      render();
    });
});

elements.saveDialogCancel.addEventListener("click", closeSaveDialog);
elements.saveDialogClose.addEventListener("click", closeSaveDialog);
elements.saveDialog.addEventListener("click", (event) => {
  if (event.target === elements.saveDialog) {
    closeSaveDialog();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.saveDialog.hidden) {
    closeSaveDialog();
  }

  if (event.key === "Escape" && !elements.deleteDialog.hidden) {
    closeDeleteDialog();
  }

  if (event.key === "Escape" && !elements.attachDialog.hidden) {
    closeAttachDialog();
  }
});

elements.deleteDialogCancel.addEventListener("click", closeDeleteDialog);
elements.deleteDialogClose.addEventListener("click", closeDeleteDialog);
elements.deleteDialog.addEventListener("click", (event) => {
  if (event.target === elements.deleteDialog) {
    closeDeleteDialog();
  }
});
elements.deleteDialogConfirm.addEventListener("click", () => {
  deleteSelectedSession().catch((error) => {
    setStatus(error.message, "error");
    closeDeleteDialog();
    render();
  });
});

elements.modelSelect.addEventListener("change", async (event) => {
  state.model = event.target.value;
  try {
    await updateConfig();
  } catch (error) {
    setStatus(error.message, "error");
    await loadSession(state.currentSessionId);
  }
});

elements.presetSelect.addEventListener("change", async (event) => {
  state.preset = event.target.value;
  try {
    await updateConfig();
  } catch (error) {
    setStatus(error.message, "error");
    await loadSession(state.currentSessionId);
  }
});

elements.composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (state.sending) {
    return;
  }

  const message = elements.composerInput.value.trim();

  if (!message) {
    return;
  }

  elements.composerInput.value = "";
  await streamChat(message);
});

for (const button of elements.quickPromptButtons) {
  button.addEventListener("click", () => {
    const filePrompt = button.dataset.filePrompt;
    const prompt = button.dataset.prompt;

    if (filePrompt) {
      if (!state.currentFile) {
        setStatus("Select a file first.", "error");
        renderStatus();
        return;
      }

      appendComposerText(`${filePrompt} \`${state.currentFile}\``);
      return;
    }

    appendComposerText(prompt);
  });
}

elements.composerInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composerForm.requestSubmit();
  }
});

init().catch((error) => {
  console.error(error);
  setStatus(`Failed to load UI: ${error.message}`, "error");
  renderStatus();
  elements.chatLog.innerHTML = `<p class="empty-state">Failed to load UI: ${escapeHtml(error.message)}</p>`;
});
