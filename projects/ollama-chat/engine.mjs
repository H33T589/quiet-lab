import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPresets, resolvePreset } from "./presets.mjs";
import {
  executeToolCall,
  findRepoPathCandidates,
  listTools,
  repoRoot,
  toolDefinitions,
} from "./tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const sessionsDir = path.join(__dirname, "sessions");

const defaultBaseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const defaultModel = process.env.OLLAMA_MODEL || "llama3.2:3b";
const maxToolRounds = 5;

function createBasePrompt(preset, systemPromptOverride = null) {
  return systemPromptOverride || resolvePreset(preset) || resolvePreset("coder");
}

function buildSystemPrompt(prompt) {
  return [
    prompt,
    `You are operating inside the local repository "${path.basename(repoRoot)}".`,
    `Repository root: ${repoRoot}`,
    "You have read-only tools for repository inspection.",
    "For non-repository questions, answer normally in the active preset voice and do not mention repo tools unless the user asked about the repository or you actually used them.",
    "Use tools when the user asks about files, code, structure, paths, presets, README contents, or anything repo-specific.",
    "Prefer list_repo_files for directory structure, read_repo_file for specific files, and search_repo only when you need to locate unknown text or symbols.",
    "Do not use search_repo as a substitute for opening a known file.",
    "Never claim to have inspected code unless you actually used a tool.",
    "Never output shell commands, pseudo-terminal output, or fake command traces.",
    "If a tool returns zero matches, say exactly that. Do not convert zero matches into 'file does not exist' unless the tool explicitly says the target path is missing.",
    "If the repo evidence is incomplete, say so directly instead of filling gaps with guesses.",
    "Available tools:",
    listTools(),
  ].join("\n\n");
}

function shouldUseRepoTools(userInput, preset) {
  if (preset === "repo") {
    return true;
  }

  return /\b(repo|repository|file|files|folder|directory|path|paths|readme|preset|presets|tool|tools|search|read|edit|codebase|source|line|lines|commit|gitignore)\b/i.test(
    userInput,
  );
}

function extractPathLikeHints(userInput) {
  const matches = new Set();
  const regex =
    /(?:^|[\s"'`(])((?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|\.gitignore|README\.md|[A-Za-z0-9._-]+\.(?:md|mjs|js|json|ts|tsx|jsx|yml|yaml|txt))(?=$|[\s"'`),.:;!?])/g;

  for (const match of userInput.matchAll(regex)) {
    const value = match[1]?.trim();

    if (value) {
      matches.add(value);
    }
  }

  return [...matches].slice(0, 4);
}

function buildToolCall(name, args) {
  return {
    function: {
      name,
      arguments: args,
    },
  };
}

async function buildBootstrapContext(userInput) {
  const bootstrap = [];
  const seen = new Set();
  const lowered = userInput.toLowerCase();

  function addToolCall(name, args) {
    const key = `${name}:${JSON.stringify(args)}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    bootstrap.push(buildToolCall(name, args));
  }

  const hintedPaths = extractPathLikeHints(userInput);

  for (const hintedPath of hintedPaths) {
    const candidates = await findRepoPathCandidates(hintedPath);

    if (candidates.length === 1) {
      addToolCall("read_repo_file", { path: candidates[0] });
    } else if (candidates.length > 1) {
      addToolCall("list_repo_files", { path: ".", depth: 2, max_entries: 80 });
    }
  }

  if (/\bpreset|presets\b/i.test(lowered) || /system prompt/i.test(lowered)) {
    addToolCall("read_repo_file", { path: "projects/ollama-chat/presets.mjs" });
  }

  if (/\breadme\b/i.test(lowered)) {
    addToolCall("read_repo_file", { path: "projects/ollama-chat/README.md" });
  }

  if (/\bcommit|committed|gitignore|ignored\b/i.test(lowered)) {
    addToolCall("read_repo_file", { path: ".gitignore" });
    addToolCall("read_repo_file", { path: "projects/ollama-chat/README.md" });
  }

  if (/\btool|tools\b/i.test(lowered)) {
    addToolCall("read_repo_file", { path: "projects/ollama-chat/tools.mjs" });
  }

  return bootstrap;
}

function formatBootstrapContext(results) {
  if (!results.length) {
    return null;
  }

  return [
    "Trusted repo context collected before answering this turn:",
    ...results.map(
      ({ name, content }, index) => `Context ${index + 1} from ${name}:\n${content}`,
    ),
    "Use this evidence directly. If it is still insufficient, call more tools. Do not contradict this evidence without stronger tool output.",
  ].join("\n\n");
}

function getBootstrapResult(results, toolName, pathSuffix = null) {
  return results.find(({ name, content }) => {
    if (name !== toolName) {
      return false;
    }

    if (!pathSuffix) {
      return true;
    }

    return content.includes(`PATH: ${pathSuffix}`);
  });
}

function getToolField(content, field) {
  const match = content.match(new RegExp(`^${field}:\\s*(.*)$`, "m"));
  return match?.[1]?.trim() || null;
}

function getToolBlock(content, field) {
  const marker = `${field}:`;
  const index = content.indexOf(marker);

  if (index === -1) {
    return "";
  }

  return content.slice(index + marker.length).trim();
}

function getReadRepoFileText(content) {
  return getToolBlock(content, "CONTENT")
    .split("\n")
    .map((line) => line.replace(/^\d+:\s?/, ""))
    .join("\n")
    .trim();
}

function extractPresetNamesFromContent(content) {
  const block = getToolBlock(content, "CONTENT");
  return [...block.matchAll(/^\d+:\s+([a-zA-Z0-9_-]+):(?:\s*["']|\s*$)/gm)].map(
    (match) => match[1],
  );
}

function answerPresetQuestion(userInput, bootstrapResults) {
  if (!/\bpreset|presets\b/i.test(userInput)) {
    return null;
  }

  const presetFile = getBootstrapResult(
    bootstrapResults,
    "read_repo_file",
    "projects/ollama-chat/presets.mjs",
  );

  if (!presetFile || getToolField(presetFile.content, "STATUS") !== "OK") {
    return null;
  }

  const presets = extractPresetNamesFromContent(presetFile.content);

  if (!presets.length) {
    return null;
  }

  if (/\bwhere\b.*\bdefined\b/i.test(userInput)) {
    return `Presets are defined in \`projects/ollama-chat/presets.mjs\`. The available presets are: ${presets.join(", ")}.`;
  }

  if (/\bavailable presets\b/i.test(userInput) || /\blist\b.*\bpreset/i.test(userInput)) {
    return `The available presets are: ${presets.join(", ")}. They are defined in \`projects/ollama-chat/presets.mjs\`.`;
  }

  return null;
}

function answerReadmeQuestion(userInput, bootstrapResults) {
  if (!/\breadme(?:\.md)?\b/i.test(userInput)) {
    return null;
  }

  const readmeFile = getBootstrapResult(
    bootstrapResults,
    "read_repo_file",
    "projects/ollama-chat/README.md",
  );

  if (!readmeFile || getToolField(readmeFile.content, "STATUS") !== "OK") {
    return null;
  }

  const text = getReadRepoFileText(readmeFile.content);

  if (!text) {
    return null;
  }

  const title =
    text
      .split("\n")
      .find((line) => line.trim().startsWith("# "))
      ?.replace(/^#\s+/, "")
      .trim() || "README";
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => !block.startsWith("#"));
  const bullets = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line))
    .map((line) => line.replace(/^-\s+/, ""))
    .slice(0, 4);
  const summary = paragraphs[0] || "This README describes the project and how to run it.";

  if (/^\s*readme(?:\.md)?\s*$/i.test(userInput) || /\bsummar/i.test(userInput)) {
    return [
      `${title}: ${summary}`,
      bullets.length ? `Key points: ${bullets.join("; ")}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/\bwhat\b.*\breadme\b/i.test(userInput) || /\bexplain\b.*\breadme\b/i.test(userInput)) {
    return [
      `${title}: ${summary}`,
      bullets.length ? `It highlights: ${bullets.join("; ")}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return null;
}

function answerPromptFileQuestion(userInput, bootstrapResults) {
  if (!/what file should i edit/i.test(userInput) || !/system prompt/i.test(userInput)) {
    return null;
  }

  const presetFile = getBootstrapResult(
    bootstrapResults,
    "read_repo_file",
    "projects/ollama-chat/presets.mjs",
  );

  if (!presetFile || getToolField(presetFile.content, "STATUS") !== "OK") {
    return null;
  }

  return "Edit `projects/ollama-chat/presets.mjs`. That file defines the preset prompt strings such as `coder`, `brainstorm`, `repo`, `summarize`, and `tutor`.";
}

function answerCommitabilityQuestion(userInput, bootstrapResults) {
  if (!/\bcommit|committed|gitignore|ignored\b/i.test(userInput)) {
    return null;
  }

  const gitignore = getBootstrapResult(bootstrapResults, "read_repo_file", ".gitignore");
  const readme = getBootstrapResult(
    bootstrapResults,
    "read_repo_file",
    "projects/ollama-chat/README.md",
  );
  const pathHints = extractPathLikeHints(userInput);
  const askedPath = pathHints[0] || null;
  const gitignoreBlock = gitignore ? getToolBlock(gitignore.content, "CONTENT") : "";
  const readmeBlock = readme ? getToolBlock(readme.content, "CONTENT") : "";
  const documentedSessionPath = readmeBlock.match(
    /projects\/ollama-chat\/sessions\/latest\.json/,
  )?.[0];
  const sessionsIgnored = /projects\/ollama-chat\/sessions\//.test(gitignoreBlock);
  const readmeSaysLocalOnly = /ignored by git and is meant for local use only/i.test(
    readmeBlock,
  );

  if (
    askedPath &&
    /sessions\/latest\.json/i.test(askedPath) &&
    documentedSessionPath &&
    sessionsIgnored
  ) {
    return [
      `The exact path \`${askedPath}\` is not a tracked repo file, but the repo does document \`${documentedSessionPath}\` in the ollama-chat README.`,
      `That session path lives under \`projects/ollama-chat/sessions/\`, which is ignored by git in \`.gitignore\`.`,
      readmeSaysLocalOnly
        ? "The README also says that directory is meant for local use only, so it should not be committed."
        : "That means it is local session state and should not be committed.",
    ].join(" ");
  }

  return null;
}

function answerFromBootstrap(userInput, bootstrapResults) {
  return (
    answerPromptFileQuestion(userInput, bootstrapResults) ||
    answerPresetQuestion(userInput, bootstrapResults) ||
    answerReadmeQuestion(userInput, bootstrapResults) ||
    answerCommitabilityQuestion(userInput, bootstrapResults)
  );
}

async function requestRecoveryAnswer({ baseUrl, model, messagesForRequest }) {
  const recovery = await requestAssistant({
    baseUrl,
    model,
    messagesForRequest: [
      ...messagesForRequest,
      {
        role: "system",
        content:
          "Answer now using the repo evidence already in the conversation. Do not call tools. If the user gave only a filename or short repo reference, explain or summarize that target directly instead of describing your capabilities.",
      },
    ],
    stream: false,
    includeTools: false,
  });

  return recovery.content || "";
}

function deriveSessionTitle(messages) {
  const firstUser = messages.find((message) => message.role === "user")?.content?.trim();
  if (!firstUser) {
    return "New session";
  }

  const normalized = firstUser.replace(/\s+/g, " ").trim();
  return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized;
}

async function requestAssistant({
  baseUrl,
  model,
  messagesForRequest,
  stream,
  includeTools,
  onToken = () => {},
}) {
  let response;

  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream,
        messages: messagesForRequest,
        ...(includeTools ? { tools: toolDefinitions } : {}),
      }),
    });
  } catch {
    throw new Error(`Could not reach Ollama at ${baseUrl}. Make sure Ollama is running.`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${body}`);
  }

  if (!stream) {
    const data = await response.json();
    return {
      content: data.message?.content?.trim() || "",
      toolCalls: data.message?.tool_calls || [],
    };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      const data = JSON.parse(line);
      const token = data.message?.content || "";

      if (token) {
        onToken(token);
        content += token;
      }
    }
  }

  if (buffer.trim()) {
    const data = JSON.parse(buffer.trim());
    const token = data.message?.content || "";

    if (token) {
      onToken(token);
      content += token;
    }
  }

  return { content: content.trim(), toolCalls: [] };
}

export function createSessionId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function normalizeSessionId(value = "latest") {
  const sessionId = String(value || "latest")
    .trim()
    .replace(/\.json$/i, "");

  if (
    !sessionId ||
    sessionId.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(sessionId)
  ) {
    throw new Error(
      "Session ID must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens.",
    );
  }

  return sessionId;
}

export class ChatSession {
  constructor({
    sessionId = "latest",
    model = defaultModel,
    preset = process.env.OLLAMA_PRESET || "coder",
    baseUrl = defaultBaseUrl,
    systemPromptOverride = null,
  } = {}) {
    this.sessionId = normalizeSessionId(sessionId);
    this.baseUrl = baseUrl;
    this.model = model;
    this.systemPromptOverride = systemPromptOverride;
    this.activePreset = systemPromptOverride ? "custom" : preset;
    this.basePrompt = createBasePrompt(preset, systemPromptOverride);
    this.systemPrompt = buildSystemPrompt(this.basePrompt);
    this.messages = [{ role: "system", content: this.systemPrompt }];
    this.updatedAt = null;
  }

  get filePath() {
    return path.join(sessionsDir, `${normalizeSessionId(this.sessionId)}.json`);
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      title: deriveSessionTitle(this.messages),
      model: this.model,
      baseUrl: this.baseUrl,
      preset: this.activePreset,
      basePrompt: this.basePrompt,
      systemPrompt: this.systemPrompt,
      repoRoot,
      updatedAt: this.updatedAt,
      messages: this.messages,
    };
  }

  async save() {
    await mkdir(sessionsDir, { recursive: true });
    this.updatedAt = new Date().toISOString();
    await writeFile(
      this.filePath,
      JSON.stringify(
        {
          ...this.toJSON(),
          updatedAt: this.updatedAt,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const saved = JSON.parse(raw);
      const savedMessages = Array.isArray(saved.messages) ? saved.messages : null;

      if (!savedMessages?.length) {
        return false;
      }

      this.model = saved.model || this.model;
      this.activePreset = this.systemPromptOverride ? "custom" : saved.preset || this.activePreset;
      this.basePrompt =
        this.systemPromptOverride ||
        saved.basePrompt ||
        resolvePreset(saved.preset) ||
        this.basePrompt;
      this.systemPrompt = buildSystemPrompt(this.basePrompt);
      this.updatedAt = saved.updatedAt || this.updatedAt;

      const hydrated = [...savedMessages];
      if (hydrated[0]?.role === "system") {
        hydrated[0] = { role: "system", content: this.systemPrompt };
      } else {
        hydrated.unshift({ role: "system", content: this.systemPrompt });
      }

      this.messages = hydrated;
      return true;
    } catch {
      return false;
    }
  }

  async reset() {
    this.systemPrompt = buildSystemPrompt(this.basePrompt);
    this.messages = [{ role: "system", content: this.systemPrompt }];
    await this.save();
  }

  async setPreset(preset, { resetHistory = true } = {}) {
    const prompt = resolvePreset(preset);

    if (!prompt) {
      throw new Error(`Unknown preset "${preset}". Available presets: ${listPresets().join(", ")}`);
    }

    this.activePreset = preset;
    this.basePrompt = prompt;
    this.systemPrompt = buildSystemPrompt(this.basePrompt);

    if (resetHistory) {
      this.messages = [{ role: "system", content: this.systemPrompt }];
    } else {
      this.messages[0] = { role: "system", content: this.systemPrompt };
    }

    await this.save();
  }

  async setModel(model) {
    this.model = model;
    await this.save();
  }

  async chat(
    userInput,
    {
      onToken = () => {},
      onToolCall = () => {},
      onToolResult = () => {},
      onFinal = () => {},
    } = {},
  ) {
    this.messages.push({ role: "user", content: userInput });

    if (!shouldUseRepoTools(userInput, this.activePreset)) {
      const assistant = await requestAssistant({
        baseUrl: this.baseUrl,
        model: this.model,
        messagesForRequest: this.messages,
        stream: true,
        includeTools: false,
        onToken,
      });

      this.messages.push({ role: "assistant", content: assistant.content });
      await this.save();
      onFinal(assistant.content);
      return { text: assistant.content, toolEvents: [] };
    }

    const bootstrapCalls = await buildBootstrapContext(userInput);
    const bootstrapResults = [];
    const seenToolCalls = new Set();
    const toolEvents = [];

    for (const call of bootstrapCalls) {
      onToolCall(call);
      const result = await executeToolCall(call);
      onToolResult({ call, result });
      bootstrapResults.push({ name: call.function.name, content: result });
      toolEvents.push({ type: "bootstrap", call, result });
    }

    const bootstrapContext = formatBootstrapContext(bootstrapResults);
    const bootstrapAnswer = answerFromBootstrap(userInput, bootstrapResults);

    if (bootstrapAnswer) {
      this.messages.push({ role: "assistant", content: bootstrapAnswer });
      await this.save();
      onFinal(bootstrapAnswer);
      return { text: bootstrapAnswer, toolEvents };
    }

    for (let round = 0; round < maxToolRounds; round += 1) {
      const assistant = await requestAssistant({
        baseUrl: this.baseUrl,
        model: this.model,
        messagesForRequest: bootstrapContext
          ? [...this.messages, { role: "system", content: bootstrapContext }]
          : this.messages,
        stream: false,
        includeTools: true,
      });

      if (assistant.toolCalls.length) {
        this.messages.push({
          role: "assistant",
          content: assistant.content || "",
          tool_calls: assistant.toolCalls,
        });

        let sawNewToolCall = false;

        for (const call of assistant.toolCalls) {
          const callKey = `${call.function.name}:${JSON.stringify(call.function.arguments || {})}`;

          if (!seenToolCalls.has(callKey)) {
            sawNewToolCall = true;
            seenToolCalls.add(callKey);
          }

          onToolCall(call);
          const result = await executeToolCall(call);
          onToolResult({ call, result });
          toolEvents.push({ type: "tool", call, result });
          this.messages.push({
            role: "tool",
            tool_name: call.function.name,
            content: result,
          });
        }

        if (!sawNewToolCall) {
          break;
        }

        continue;
      }

      if (assistant.content) {
        this.messages.push({ role: "assistant", content: assistant.content });
        await this.save();
        onFinal(assistant.content);
        return { text: assistant.content, toolEvents };
      }
    }

    const finalAssistant = await requestAssistant({
      baseUrl: this.baseUrl,
      model: this.model,
      messagesForRequest: [
        ...(bootstrapContext
          ? [...this.messages, { role: "system", content: bootstrapContext }]
          : this.messages),
        {
          role: "system",
          content:
            "Answer now using the gathered repo evidence. Do not call tools again. If the evidence is incomplete, say exactly what is missing.",
        },
      ],
      stream: false,
      includeTools: false,
    });

    if (finalAssistant.content) {
      this.messages.push({ role: "assistant", content: finalAssistant.content });
      await this.save();
      onFinal(finalAssistant.content);
      return { text: finalAssistant.content, toolEvents };
    }

    const recoveryContent = await requestRecoveryAnswer({
      baseUrl: this.baseUrl,
      model: this.model,
      messagesForRequest: bootstrapContext
        ? [...this.messages, { role: "system", content: bootstrapContext }]
        : this.messages,
    });

    if (recoveryContent) {
      this.messages.push({ role: "assistant", content: recoveryContent });
      await this.save();
      onFinal(recoveryContent);
      return { text: recoveryContent, toolEvents };
    }

    const fallback =
      "I gathered repo context, but the model failed to turn it into a final answer. Try asking with a little more detail, such as the file path or what you want summarized.";
    this.messages.push({ role: "assistant", content: fallback });
    await this.save();
    onFinal(fallback);
    return { text: fallback, toolEvents };
  }
}

export async function listSessionSummaries() {
  await mkdir(sessionsDir, { recursive: true });
  const files = (await readdir(sessionsDir))
    .filter((file) => file.endsWith(".json"))
    .sort();

  const summaries = [];

  for (const file of files) {
    try {
      const raw = await readFile(path.join(sessionsDir, file), "utf8");
      const saved = JSON.parse(raw);
      const messages = Array.isArray(saved.messages) ? saved.messages : [];
      summaries.push({
        sessionId: file.replace(/\.json$/, ""),
        title: saved.title || deriveSessionTitle(messages),
        updatedAt: saved.updatedAt || null,
        model: saved.model || defaultModel,
        preset: saved.preset || "coder",
        messageCount: Math.max(messages.length - 1, 0),
      });
    } catch {
      // ignore invalid session files
    }
  }

  return summaries.sort((a, b) => {
    const left = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const right = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return right - left;
  });
}

export async function getSessionSnapshot(sessionId) {
  const session = new ChatSession({ sessionId });
  const loaded = await session.load();

  if (!loaded) {
    await session.save();
  }

  return session.toJSON();
}

export async function listAvailableModels(baseUrl = defaultBaseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return Array.isArray(data.models)
      ? data.models.map((model) => model.name).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}
