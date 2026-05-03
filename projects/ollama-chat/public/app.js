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
  controlCenterOpen: false,
  customPresets: [],
  tooling: {
    budgets: {},
    config: null,
    profiles: {},
    tools: [],
  },
  toolEvents: [],
  workspace: {
    attached: false,
    recentCodebases: [],
    repoName: null,
  },
};

const elements = {
  chatLog: document.querySelector("#chat-log"),
  clearToolsButton: document.querySelector("#clear-tools-button"),
  composerForm: document.querySelector("#composer-form"),
  composerInput: document.querySelector("#composer-input"),
  budgetOptions: document.querySelector("#budget-options"),
  controlCenter: document.querySelector("#control-center"),
  controlCenterBackdrop: document.querySelector("#control-center-backdrop"),
  controlCenterButton: document.querySelector("#control-center-button"),
  controlCenterClose: document.querySelector("#control-center-close"),
  customPresetForm: document.querySelector("#custom-preset-form"),
  customPresetList: document.querySelector("#custom-preset-list"),
  customPresetName: document.querySelector("#custom-preset-name"),
  customPresetPrompt: document.querySelector("#custom-preset-prompt"),
  deleteDialog: document.querySelector("#delete-dialog"),
  deleteDialogCancel: document.querySelector("#delete-dialog-cancel"),
  deleteDialogClose: document.querySelector("#delete-dialog-close"),
  deleteDialogConfirm: document.querySelector("#delete-dialog-confirm"),
  deleteDialogCopy: document.querySelector("#delete-dialog-copy"),
  filePreview: document.querySelector("#file-preview"),
  filePreviewTitle: document.querySelector("#file-preview-title"),
  diagnosticsList: document.querySelector("#diagnostics-list"),
  drawerClearTools: document.querySelector("#drawer-clear-tools"),
  drawerNewSession: document.querySelector("#drawer-new-session"),
  drawerResetSession: document.querySelector("#drawer-reset-session"),
  drawerSaveSession: document.querySelector("#drawer-save-session"),
  drawerSwitchWorkspace: document.querySelector("#drawer-switch-workspace"),
  hiddenPathList: document.querySelector("#hidden-path-list"),
  messageTemplate: document.querySelector("#message-template"),
  modelSelect: document.querySelector("#model-select"),
  newSessionButton: document.querySelector("#new-session-button"),
  presetSelect: document.querySelector("#preset-select"),
  quickPromptButtons: document.querySelectorAll(".quick-prompts button"),
  repoBreadcrumbs: document.querySelector("#repo-breadcrumbs"),
  repoFilterInput: document.querySelector("#repo-filter-input"),
  repoRootButton: document.querySelector("#repo-root-button"),
  repoTree: document.querySelector("#repo-tree"),
  recentWorkspaces: document.querySelector("#recent-workspaces"),
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
  switchWorkspaceButton: document.querySelector("#switch-workspace-button"),
  toolProfileOptions: document.querySelector("#tool-profile-options"),
  toolToggleList: document.querySelector("#tool-toggle-list"),
  toolEvents: document.querySelector("#tool-events"),
  workspaceDialog: document.querySelector("#workspace-dialog"),
  workspaceDialogBrowse: document.querySelector("#workspace-dialog-browse"),
  workspaceDialogCancel: document.querySelector("#workspace-dialog-cancel"),
  workspaceDialogClose: document.querySelector("#workspace-dialog-close"),
  workspaceDialogForm: document.querySelector("#workspace-dialog-form"),
  workspaceDialogInput: document.querySelector("#workspace-dialog-input"),
  workspaceTitle: document.querySelector("#workspace-title"),
};

const customPresetStorageKey = "quiet-lab.customPresets.v1";

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
    const error = new Error(payload.error || "Request failed");
    error.status = response.status;
    error.url = url;
    throw error;
  }

  return response.json();
}

function setStatus(text, tone = "neutral") {
  state.statusText = text;
  state.statusTone = tone;
}

function showError(error) {
  setStatus(error.message, "error");
  render();
}

function loadCustomPresetsFromStorage() {
  try {
    const saved = JSON.parse(localStorage.getItem(customPresetStorageKey) || "[]");
    state.customPresets = Array.isArray(saved)
      ? saved.filter((preset) => preset?.name && preset?.prompt)
      : [];
  } catch {
    state.customPresets = [];
  }
}

function saveCustomPresetsToStorage() {
  localStorage.setItem(customPresetStorageKey, JSON.stringify(state.customPresets));
}

function getCustomPresetByValue(value) {
  return state.customPresets.find((preset) => `custom:${preset.name}` === value);
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
    elements.repoTree.innerHTML = `<p class="empty-state">Switch to a repository folder to browse files.</p>`;
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
    "Select a repository file to preview it here with line numbers.";
  elements.selectedFileButton.disabled = !state.currentFile;
}

function renderWorkspace() {
  elements.workspaceTitle.textContent = state.workspace.repoName || "No repo";

  elements.recentWorkspaces.innerHTML = "";
  const recent = state.workspace.recentCodebases || [];

  if (!recent.length) {
    elements.recentWorkspaces.innerHTML = `<p class="empty-state">No recent repositories.</p>`;
    return;
  }

  for (const recentPath of recent) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-workspace-button";
    button.textContent = recentPath;
    button.addEventListener("click", () => switchWorkspace(recentPath).catch(showError));
    elements.recentWorkspaces.append(button);
  }
}

function renderSegmentedOptions(container, items, activeValue, onSelect) {
  container.innerHTML = "";

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `segment-option${item.value === activeValue ? " active" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(item.label)}</strong>
      <span>${escapeHtml(item.description || "")}</span>
    `;
    button.disabled = state.sending;
    button.addEventListener("click", () => onSelect(item.value));
    container.append(button);
  }
}

function renderControlCenter() {
  elements.controlCenter.hidden = !state.controlCenterOpen;
  elements.controlCenterBackdrop.hidden = !state.controlCenterOpen;
  elements.controlCenterButton.setAttribute("aria-expanded", state.controlCenterOpen ? "true" : "false");

  const config = state.tooling.config;
  const profiles = state.tooling.profiles || {};
  const budgets = state.tooling.budgets || {};

  if (config) {
    renderSegmentedOptions(
      elements.toolProfileOptions,
      Object.entries(profiles).map(([value, profile]) => ({
        value,
        label: profile.label || value,
        description: `${profile.enabledTools?.length || 0} tools`,
      })),
      config.profile,
      (profile) => updateTooling({ profile }).catch(showError),
    );

    renderSegmentedOptions(
      elements.budgetOptions,
      Object.entries(budgets).map(([value, budget]) => ({
        value,
        label: budget.label || value,
        description: `${budget.maxToolRounds} rounds · ${budget.maxFileLines} lines`,
      })),
      config.budget,
      (budget) => updateTooling({ budget }).catch(showError),
    );
  }

  elements.toolToggleList.innerHTML = "";
  for (const tool of state.tooling.tools || []) {
    const label = document.createElement("label");
    label.className = "tool-toggle-row";
    label.innerHTML = `
      <input type="checkbox" ${tool.enabled ? "checked" : ""} />
      <span>
        <strong>${escapeHtml(tool.name)}</strong>
        <small>${escapeHtml(tool.cost)} · ${escapeHtml(tool.description)}</small>
      </span>
    `;
    const checkbox = label.querySelector("input");
    checkbox.disabled = state.sending;
    checkbox.addEventListener("change", () => {
      const enabledTools = state.tooling.tools
        .filter((candidate) => (candidate.name === tool.name ? checkbox.checked : candidate.enabled))
        .map((candidate) => candidate.name);
      updateTooling({ enabledTools }).catch(showError);
    });
    elements.toolToggleList.append(label);
  }

  elements.hiddenPathList.innerHTML = (state.meta?.hiddenPaths || [])
    .map((hiddenPath) => `<span>${escapeHtml(hiddenPath)}</span>`)
    .join("");

  renderCustomPresets();
  renderDiagnostics();
}

function renderCustomPresets() {
  elements.customPresetList.innerHTML = "";

  if (!state.customPresets.length) {
    elements.customPresetList.innerHTML = `<p class="empty-state">No custom presets yet.</p>`;
    return;
  }

  for (const preset of state.customPresets) {
    const chip = document.createElement("div");
    chip.className = "preset-chip";
    chip.innerHTML = `
      <span>${escapeHtml(preset.name)}</span>
      <button type="button" aria-label="Delete ${escapeHtml(preset.name)}">×</button>
    `;
    chip.querySelector("button").addEventListener("click", () => {
      state.customPresets = state.customPresets.filter((candidate) => candidate.name !== preset.name);
      saveCustomPresetsToStorage();
      renderPresetSelect();
      renderControlCenter();
    });
    elements.customPresetList.append(chip);
  }
}

function renderDiagnostics() {
  const config = state.tooling.config;
  const items = [
    ["Model", state.model || state.meta?.defaultModel || "none"],
    ["Preset", state.preset || "coder"],
    ["Tool mode", config?.profile || "unknown"],
    ["Budget", config?.budget || "unknown"],
    ["Enabled tools", String(config?.enabledTools?.length || 0)],
    ["Tool events", String(state.toolEvents.length)],
    ["Ollama", state.meta?.ollamaReachable ? "online" : "offline"],
    ["Repository", state.workspace.repoName || "none"],
  ];

  elements.diagnosticsList.innerHTML = items
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
}

function renderPresetSelect() {
  const builtinOptions = (state.meta?.presets || [])
    .map((preset) => `<option value="${escapeHtml(preset)}">${escapeHtml(preset)}</option>`)
    .join("");
  const customOptions = state.customPresets.length
    ? `<optgroup label="Custom">${state.customPresets
        .map((preset) => `<option value="custom:${escapeHtml(preset.name)}">${escapeHtml(preset.name)}</option>`)
        .join("")}</optgroup>`
    : "";

  elements.presetSelect.innerHTML = `${builtinOptions}${customOptions}`;
  elements.presetSelect.value = state.preset || "coder";
}

function syncControls() {
  elements.modelSelect.value = state.model || state.meta?.defaultModel || "";
  elements.presetSelect.value = state.preset || "coder";
  const sendDisabled = state.sending || !state.currentSessionId;

  elements.composerInput.disabled = sendDisabled;
  elements.modelSelect.disabled = state.sending;
  elements.newSessionButton.disabled = state.sending;
  elements.presetSelect.disabled = state.sending;
  elements.repoFilterInput.disabled = state.sending;
  elements.repoRootButton.disabled = state.sending || !state.workspace.attached;
  elements.switchWorkspaceButton.disabled = state.sending;
  elements.resetSessionButton.disabled = state.sending || !state.currentSessionId;
  elements.saveSessionButton.disabled = state.sending || !state.currentSessionId || getVisibleMessages().length === 0;
  elements.selectedFileButton.disabled = state.sending || !state.currentFile;
  elements.sendButton.disabled = sendDisabled;
  elements.drawerNewSession.disabled = state.sending;
  elements.drawerResetSession.disabled = state.sending || !state.currentSessionId;
  elements.drawerSaveSession.disabled = state.sending || !state.currentSessionId || getVisibleMessages().length === 0;
  elements.drawerClearTools.disabled = state.sending || !state.toolEvents.length;
  elements.drawerSwitchWorkspace.disabled = state.sending;
  elements.sendButton.textContent = state.sending ? "Sending..." : "Send";
  for (const button of elements.quickPromptButtons) {
    button.disabled = state.sending;
  }
}

function render() {
  renderStatus();
  renderWorkspace();
  renderSessionStats();
  renderSessions();
  renderMessages();
  renderToolEvents();
  renderRepoTree();
  renderBreadcrumbs();
  renderFilePreview();
  renderControlCenter();
  syncControls();
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
  state.tooling = {
    budgets: state.meta.resourceBudgets || {},
    config: state.meta.toolConfig || null,
    profiles: state.meta.toolProfiles || {},
    tools: state.meta.tools || [],
  };

  if (state.meta.ollamaReachable) {
    setStatus("Workspace ready.", "success");
  } else {
    setStatus("Ollama is offline. Start it on http://127.0.0.1:11434 to send messages.", "error");
  }

  elements.modelSelect.innerHTML = state.meta.models
    .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
    .join("");
  renderPresetSelect();
}

async function loadWorkspace() {
  state.workspace = await fetchJson("/api/workspace");
}

async function loadTooling() {
  const payload = await fetchJson("/api/tooling");
  state.tooling = {
    budgets: payload.budgets || {},
    config: payload.config || null,
    profiles: payload.profiles || {},
    tools: payload.tools || [],
  };
}

async function updateTooling(update) {
  const payload = await fetchJson("/api/tooling", {
    method: "POST",
    body: JSON.stringify(update),
  });

  state.tooling = {
    budgets: payload.budgets || state.tooling.budgets,
    config: payload.config,
    profiles: payload.profiles || state.tooling.profiles,
    tools: payload.tools || [],
  };
  setStatus(`Tooling updated: ${state.tooling.config.profile} / ${state.tooling.config.budget}.`, "success");
  render();
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
  const customPreset = getCustomPresetByValue(state.preset);
  const payload = await fetchJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      model: state.model,
      preset: state.preset,
      customPresetPrompt: customPreset?.prompt || null,
    }),
  });

  state.sessions = payload.sessions;
  state.toolEvents = [];
  setStatus("New session ready.", "success");
  await loadSession(payload.session.sessionId);
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

function openControlCenter() {
  state.controlCenterOpen = true;
  renderControlCenter();
}

function closeControlCenter() {
  state.controlCenterOpen = false;
  renderControlCenter();
}

function openWorkspaceDialog() {
  elements.workspaceDialogInput.value = "";
  elements.workspaceDialog.hidden = false;
  elements.workspaceDialogInput.focus();
}

function closeWorkspaceDialog() {
  elements.workspaceDialog.hidden = true;
}

async function switchWorkspace(inputPath) {
  const payload = await fetchJson("/api/workspace", {
    method: "POST",
    body: JSON.stringify({ path: inputPath }),
  });

  await applyWorkspacePayload(payload);
}

async function browseWorkspace() {
  setStatus("Opening folder picker...", "busy");
  render();
  let payload;

  try {
    payload = await fetchJson("/api/workspace/pick", {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch (error) {
    if (error.status === 404) {
      throw new Error("Browse Folders needs the updated local server. Stop and restart `npm run web`, then try Browse again. You can paste a folder path without restarting.");
    }

    throw error;
  }

  await applyWorkspacePayload(payload);
}

async function applyWorkspacePayload(payload) {
  state.workspace = payload;
  state.currentFile = null;
  state.filePreview = null;
  state.repoEntries = [];
  state.repoFilter = "";
  state.currentRepoPath = ".";
  state.toolEvents = [];
  elements.repoFilterInput.value = "";
  await loadRepoTree(".");
  closeWorkspaceDialog();
  closeControlCenter();
  setStatus(`Repository switched to ${payload.repoName}.`, "success");
  render();
}

function addCustomPreset(name, prompt) {
  const cleanName = String(name || "")
    .trim()
    .replace(/[^A-Za-z0-9 _-]+/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 40);
  const cleanPrompt = String(prompt || "").trim();

  if (!cleanName || !cleanPrompt) {
    throw new Error("Preset name and prompt are required.");
  }

  state.customPresets = [
    { name: cleanName, prompt: cleanPrompt },
    ...state.customPresets.filter((preset) => preset.name !== cleanName),
  ].slice(0, 12);
  saveCustomPresetsToStorage();
  renderPresetSelect();
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

  const customPreset = getCustomPresetByValue(state.preset);
  const payload = await fetchJson(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/config`, {
    method: "POST",
    body: JSON.stringify({
      model: state.model,
      preset: state.preset,
      customPresetPrompt: customPreset?.prompt || null,
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
    state.currentRepoPath = ".";
    state.repoEntries = [];
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
    setStatus("Switch to a repository first.", "error");
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
  loadCustomPresetsFromStorage();
  await loadMeta();
  await loadWorkspace();
  await loadTooling();
  await loadRepoTree(".");

  if (!state.sessions.length) {
    await createSession();
  } else {
    await loadSession(state.sessions[0].sessionId);
  }

  render();
}

elements.newSessionButton.addEventListener("click", () => {
  createSession().catch((error) => {
    setStatus(error.message, "error");
    render();
  });
});

elements.controlCenterButton.addEventListener("click", openControlCenter);
elements.controlCenterClose.addEventListener("click", closeControlCenter);
elements.controlCenterBackdrop.addEventListener("click", closeControlCenter);
elements.switchWorkspaceButton.addEventListener("click", openWorkspaceDialog);
elements.drawerSwitchWorkspace.addEventListener("click", openWorkspaceDialog);

elements.workspaceDialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  switchWorkspace(elements.workspaceDialogInput.value).catch(showError);
});
elements.workspaceDialogBrowse.addEventListener("click", () => {
  browseWorkspace().catch(showError);
});
elements.workspaceDialogCancel.addEventListener("click", closeWorkspaceDialog);
elements.workspaceDialogClose.addEventListener("click", closeWorkspaceDialog);
elements.workspaceDialog.addEventListener("click", (event) => {
  if (event.target === elements.workspaceDialog) {
    closeWorkspaceDialog();
  }
});

elements.drawerNewSession.addEventListener("click", () => {
  closeControlCenter();
  createSession().catch(showError);
});

elements.drawerSaveSession.addEventListener("click", () => {
  closeControlCenter();
  openSaveDialog();
});

elements.drawerResetSession.addEventListener("click", () => {
  closeControlCenter();
  resetSession().catch(showError);
});

elements.drawerClearTools.addEventListener("click", () => {
  state.toolEvents = [];
  setStatus("Tool activity cleared.", "neutral");
  render();
});

elements.customPresetForm.addEventListener("submit", (event) => {
  event.preventDefault();

  try {
    addCustomPreset(elements.customPresetName.value, elements.customPresetPrompt.value);
    elements.customPresetName.value = "";
    elements.customPresetPrompt.value = "";
    setStatus("Custom preset added.", "success");
    render();
  } catch (error) {
    showError(error);
  }
});

elements.repoRootButton.addEventListener("click", () => {
  loadRepoTree(".").catch((error) => {
    setStatus(error.message, "error");
    render();
  });
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
  if (event.key === "Escape" && state.controlCenterOpen) {
    closeControlCenter();
  }

  if (event.key === "Escape" && !elements.workspaceDialog.hidden) {
    closeWorkspaceDialog();
  }

  if (event.key === "Escape" && !elements.saveDialog.hidden) {
    closeSaveDialog();
  }

  if (event.key === "Escape" && !elements.deleteDialog.hidden) {
    closeDeleteDialog();
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
