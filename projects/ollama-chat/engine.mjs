import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatProjectMemoryContext,
  loadProjectMemory,
  updateProjectMemoryFromBootstrap,
} from "./memory.mjs";
import { listPresets, resolvePreset } from "./presets.mjs";
import {
  executeToolCall,
  findRepoPathCandidates,
  getEnabledToolDefinitions,
  getToolRuntimeConfig,
  getWorkspaceName,
  hasAttachedCodebase,
  isToolEnabled,
  listTools,
} from "./tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const sessionsDir = path.join(__dirname, "sessions");

const defaultBaseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const defaultModel = process.env.OLLAMA_MODEL || "phi4-mini";
function createBasePrompt(preset, systemPromptOverride = null) {
  return systemPromptOverride || resolvePreset(preset) || resolvePreset("coder");
}

function buildSystemPrompt(prompt) {
  const toolConfig = getToolRuntimeConfig();

  return [
    prompt,
    `You are operating inside the local repository "${getWorkspaceName()}".`,
    `Tool paths are repository-relative from the workspace root "${getWorkspaceName()}" — do not use absolute filesystem paths.`,
    "You have read-only tools for repository inspection.",
    `Active tool mode: ${toolConfig.profile}; resource budget: ${toolConfig.budget}. Keep tool use small and ask for narrower context when evidence is insufficient.`,
    "For non-repository questions, answer normally in the active preset voice and do not mention repo tools unless the user asked about the repository or you actually used them.",
    "Use tools when the user asks about files, code, structure, paths, presets, README contents, or anything repo-specific.",
    "Use get_repo_overview first for broad questions about what the project is, how it works, architecture, stack, entry points, or repo summaries.",
    "Use inspect_dependencies for framework, package script, dependency, build, and tooling questions.",
    "Use find_entrypoints for app flow, routing, startup, deployment, or entry point questions.",
    "Use read_many_files when an answer needs context from several known files.",
    "Use summarize_file_symbols before explaining a source file's structure when the user asks about functions, components, routes, classes, CSS selectors, or exports.",
    "Prefer list_repo_files for directory structure, read_repo_file for specific files, and search_repo only when you need to locate unknown text or symbols.",
    "Do not use search_repo as a substitute for opening a known file.",
    "Never claim to have inspected code unless you actually used a tool.",
    "Never output shell commands, pseudo-terminal output, or fake command traces.",
    "If a tool returns zero matches, say exactly that. Do not convert zero matches into 'file does not exist' unless the tool explicitly says the target path is missing.",
    "If the repo evidence is incomplete, say so directly instead of filling gaps with guesses.",
    "Enabled tools:",
    listTools({ enabledOnly: true }),
  ].join("\n\n");
}

function shouldUseRepoTools(userInput, preset) {
  if (preset === "repo") {
    return true;
  }

  return /\b(repo|repository|attached|workspace|file|files|folder|directory|path|paths|readme|preset|presets|tool|tools|search|read|edit|codebase|source|line|lines|commit|gitignore)\b/i.test(
    userInput,
  ) || /\b(code|site|app|project|review|bugs?|risks?|edge cases?|tests?|entry ?points?|stack|dependencies)\b/i.test(
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
  const { limits } = getToolRuntimeConfig();

  function addToolCall(name, args) {
    if (bootstrap.length >= limits.maxBootstrapCalls || !isToolEnabled(name)) {
      return;
    }

    const key = `${name}:${JSON.stringify(args)}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    bootstrap.push(buildToolCall(name, args));
  }

  const hintedPaths = extractPathLikeHints(userInput);
  const asksBroadOverview = /\b(what is|what's|explain|summarize|overview|how it works|how does it work|architecture|structure|repo|repository|attached|workspace|codebase|check it out|look at|project|site|app|entry point|entrypoint|main files?)\b/i.test(
    userInput,
  );
  const asksDependencies = /\b(dependencies|package|packages|framework|stack|library|libraries|build|scripts?|devdependencies|npm|pnpm|yarn|vite|next|react|astro)\b/i.test(
    userInput,
  );
  const asksEntrypoints = /\b(entry ?points?|starts?|startup|main file|routes?|routing|pages?|deployment|serve|server)\b/i.test(
    userInput,
  );
  const asksReview = /\b(review|bugs?|risks?|edge cases?|missing tests?|test ideas?|site code|app code|current code)\b/i.test(
    userInput,
  );

  for (const hintedPath of hintedPaths) {
    const candidates = await findRepoPathCandidates(hintedPath);

    if (candidates.length === 1) {
      if (/\b(symbols?|functions?|components?|classes?|exports?|selectors?|routes?)\b/i.test(lowered)) {
        addToolCall("summarize_file_symbols", { path: candidates[0] });
      } else {
        addToolCall("read_repo_file", { path: candidates[0] });
      }
    } else if (candidates.length > 1) {
      addToolCall("list_repo_files", { path: ".", depth: 2, max_entries: 80 });
    }
  }

  if (asksBroadOverview || asksReview) {
    addToolCall("get_repo_overview", { max_entries: 100 });
  }

  if (asksDependencies || asksReview) {
    addToolCall("inspect_dependencies", {});
  }

  if (asksEntrypoints || asksReview) {
    addToolCall("find_entrypoints", {});
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
    addToolCall("get_repo_overview", { max_entries: 60 });
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

function messagesWithBootstrapContext(messages, bootstrapContext, memoryContext = null) {
  if (!bootstrapContext && !memoryContext) {
    return messages;
  }

  const result = [...messages];

  if (memoryContext) {
    const systemIndex = result.findIndex((m) => m.role === "system");
    const memorySystemContent = [
      result[systemIndex]?.content,
      "--- Project Memory (persisted facts, refer to these first) ---",
      memoryContext,
      "--- End Project Memory ---",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (systemIndex !== -1) {
      result[systemIndex] = { ...result[systemIndex], content: memorySystemContent };
    } else {
      result.unshift({ role: "system", content: memorySystemContent });
    }
  }

  if (bootstrapContext) {
    result.push({
      role: "user",
      content: [
        "Attached repository evidence for my previous request:",
        bootstrapContext,
        "Answer my previous request using this repository evidence. Do not ask me to paste the file or provide a repository link if the evidence already contains the needed file or repo details.",
      ].join("\n\n"),
    });
  }

  return result;
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

function getToolListField(content, field) {
  const match = content.match(new RegExp(`(?:^|\\n)${field}:\\s*(?:\\n([\\s\\S]*?))?(?=\\n[A-Z_]+:|$)`));
  const raw = match?.[1] || "";

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "(none)" && line !== "(unknown)");
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

function answerPackageJsonQuestion(userInput, bootstrapResults) {
  if (!/\bpackage(?:\.json)?\b/i.test(userInput)) {
    return null;
  }

  const packageFile = getBootstrapResult(bootstrapResults, "read_repo_file", "package.json");

  if (!packageFile || getToolField(packageFile.content, "STATUS") !== "OK") {
    return null;
  }

  let manifest;

  try {
    manifest = JSON.parse(getReadRepoFileText(packageFile.content));
  } catch {
    return null;
  }

  const filePath = getToolField(packageFile.content, "PATH") || "package.json";
  const scripts = Object.entries(manifest.scripts || {});
  const dependencies = Object.keys(manifest.dependencies || {});
  const devDependencies = Object.keys(manifest.devDependencies || {});
  const allDependencyVersions = [
    ...Object.values(manifest.dependencies || {}),
    ...Object.values(manifest.devDependencies || {}),
  ].filter((value) => typeof value === "string");
  const risks = [];

  if (!scripts.some(([name]) => name === "test")) {
    risks.push("No `test` script is defined, so regressions are easy to miss unless tests run another way.");
  }

  if (!scripts.some(([name]) => name === "lint")) {
    risks.push("No `lint` script is defined, so style and static checks are not captured in npm scripts.");
  }

  if (allDependencyVersions.some((version) => /^[~^]/.test(version))) {
    risks.push("At least one dependency uses a range, so fresh installs may pick up newer compatible releases.");
  }

  if (!dependencies.length && !devDependencies.length) {
    risks.push("No dependencies are declared; that is fine for a static/simple project, but build scripts must rely only on the runtime environment.");
  }

  return [
    `I read \`${filePath}\`.`,
    [
      `- name: \`${manifest.name || "not set"}\``,
      `- version: \`${manifest.version || "not set"}\``,
      `- private: \`${manifest.private === true ? "true" : "false/not set"}\``,
      manifest.type ? `- module type: \`${manifest.type}\`` : null,
      scripts.length
        ? `- scripts: ${scripts.map(([name, command]) => `\`${name}\` -> \`${command}\``).join("; ")}`
        : "- scripts: none",
      dependencies.length ? `- runtime dependencies: ${dependencies.map((name) => `\`${name}\``).join(", ")}` : "- runtime dependencies: none",
      devDependencies.length ? `- dev dependencies: ${devDependencies.map((name) => `\`${name}\``).join(", ")}` : "- dev dependencies: none",
    ]
      .filter(Boolean)
      .join("\n"),
    risks.length
      ? `Risks:\n${risks.map((risk) => `- ${risk}`).join("\n")}`
      : "Risks:\n- I do not see obvious package-manifest risks from the fields present.",
  ].join("\n\n");
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

function answerWorkspaceAttachmentQuestion(userInput) {
  if (
    !/\b(attached|workspace|codebase|repo|repository)\b/i.test(userInput) ||
    !/\b(can you see|see it|check it out|look at|have access|attached)\b/i.test(userInput)
  ) {
    return null;
  }

  if (!hasAttachedCodebase()) {
    return "No codebase is attached right now. Attach a repository folder from the workspace panel, then ask again.";
  }

  return `Yes. I can see the attached repository \`${getWorkspaceName()}\` through quiet-lab's read-only repo tools. Ask for a structure summary, entry points, package scripts, dependencies, or a specific file review.`;
}

function answerRepoOverviewQuestion(userInput, bootstrapResults) {
  if (!/\b(summarize|overview|structure|entry ?points?|what is|what's|how it works|check it out|look at)\b/i.test(userInput)) {
    return null;
  }

  const overview = getBootstrapResult(bootstrapResults, "get_repo_overview");

  if (!overview || getToolField(overview.content, "STATUS") !== "OK") {
    return null;
  }

  const repo = getToolField(overview.content, "REPO") || getWorkspaceName();
  const stack = getToolField(overview.content, "STACK") || "(unknown)";
  const topLevel = getToolListField(overview.content, "TOP_LEVEL").slice(0, 12);
  const scripts = getToolListField(overview.content, "PACKAGE_SCRIPTS").slice(0, 8);
  const entrypoints = getToolListField(overview.content, "ENTRYPOINTS").slice(0, 10);
  const importantFiles = getToolListField(overview.content, "IMPORTANT_FILES").slice(0, 10);

  return [
    `I inspected the attached repository \`${repo}\`.`,
    `Stack: ${stack}.`,
    topLevel.length ? `Top-level structure:\n${topLevel.map((item) => `- \`${item}\``).join("\n")}` : null,
    entrypoints.length ? `Main entry points:\n${entrypoints.map((item) => `- \`${item}\``).join("\n")}` : null,
    scripts.length ? `Package scripts:\n${scripts.map((item) => `- ${item}`).join("\n")}` : null,
    importantFiles.length ? `Useful files to inspect next:\n${importantFiles.map((item) => `- \`${item}\``).join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function answerRepoRiskQuestion(userInput, bootstrapResults) {
  if (!/\b(review|risks?|bugs?|edge cases?|security|quality)\b/i.test(userInput)) {
    return null;
  }

  const overview = getBootstrapResult(bootstrapResults, "get_repo_overview");
  const dependencies = getBootstrapResult(bootstrapResults, "inspect_dependencies");

  if (!overview || getToolField(overview.content, "STATUS") !== "OK") {
    return null;
  }

  const repo = getToolField(overview.content, "REPO") || getWorkspaceName();
  const stack = getToolField(overview.content, "STACK") || "(unknown)";
  const scripts = getToolListField(overview.content, "PACKAGE_SCRIPTS");
  const entrypoints = getToolListField(overview.content, "ENTRYPOINTS").slice(0, 8);
  const importantFiles = getToolListField(overview.content, "IMPORTANT_FILES").slice(0, 8);
  const lockfiles = getToolListField(overview.content, "LOCKFILES");
  const manifestBlock = dependencies ? getToolBlock(dependencies.content, "MANIFESTS") : "";
  const hasTestScript = scripts.some((script) => /:\s*test\s*=|:\s*test\s/.test(script));
  const hasLintScript = scripts.some((script) => /:\s*lint\s*=|:\s*lint\s/.test(script));
  const risks = [];

  if (!hasTestScript) {
    risks.push("No package `test` script was found in the inspected manifests.");
  }

  if (!hasLintScript) {
    risks.push("No package `lint` script was found, so static checks are not part of the normal workflow.");
  }

  if (!lockfiles.length && /dependencies=|devDependencies=/i.test(manifestBlock)) {
    risks.push("No lockfile was found, so installs may drift across machines.");
  }

  if (stack === "(unknown)") {
    risks.push("The stack was not confidently detected from dependency manifests or entry files.");
  }

  if (!entrypoints.length) {
    risks.push("No clear entry point was found; startup or routing may need manual inspection.");
  }

  return [
    `I inspected \`${repo}\` using repo tools and found these review targets.`,
    `Stack: ${stack}.`,
    risks.length
      ? `Likely risks:\n${risks.map((risk) => `- ${risk}`).join("\n")}`
      : "Likely risks:\n- I do not see obvious repo-level risks from the overview, scripts, and dependency metadata alone.",
    scripts.length
      ? `Scripts found:\n${scripts.slice(0, 8).map((script) => `- ${script}`).join("\n")}`
      : "Scripts found:\n- none",
    entrypoints.length
      ? `Files to inspect next:\n${entrypoints.map((file) => `- \`${file}\``).join("\n")}`
      : importantFiles.length
        ? `Files to inspect next:\n${importantFiles.map((file) => `- \`${file}\``).join("\n")}`
        : null,
    "For a deeper review, select one of those files and run the file review workflow.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function answerTestPlanQuestion(userInput, bootstrapResults) {
  if (!/\b(test ideas?|test plan|focused tests?|suggest.*tests?|missing tests?)\b/i.test(userInput)) {
    return null;
  }

  const overview = getBootstrapResult(bootstrapResults, "get_repo_overview");

  if (!overview || getToolField(overview.content, "STATUS") !== "OK") {
    return null;
  }

  const repo = getToolField(overview.content, "REPO") || getWorkspaceName();
  const scripts = getToolListField(overview.content, "PACKAGE_SCRIPTS");
  const entrypoints = getToolListField(overview.content, "ENTRYPOINTS");
  const importantFiles = getToolListField(overview.content, "IMPORTANT_FILES");
  const targets = [...new Set([...entrypoints, ...importantFiles])].slice(0, 8);
  const hasTestScript = scripts.some((script) => /:\s*test\s*=|:\s*test\s/.test(script));
  const ideas = [
    "Path safety: traversal, absolute paths, null bytes, symlink escapes, and hidden folders stay blocked.",
    "Session safety: saved session JSON does not expose absolute workspace paths or hidden local state.",
    "Tool determinism: broad repo prompts collect overview/dependency evidence before the model answers.",
    "Tool-call recovery: JSON tool calls wrapped in prose or code fences are still executed once.",
    "UI workflow behavior: workflow buttons insert the expected prompt and selected-file workflows require a selected file.",
  ];

  return [
    `Focused test plan for \`${repo}\`:`,
    hasTestScript
      ? `Existing test script:\n${scripts.filter((script) => /:\s*test\s*=|:\s*test\s/.test(script)).map((script) => `- ${script}`).join("\n")}`
      : "Existing test script:\n- none found; add one before relying on this project for repeatable changes.",
    `Recommended tests:\n${ideas.map((idea) => `- ${idea}`).join("\n")}`,
    targets.length
      ? `Good files to target first:\n${targets.map((file) => `- \`${file}\``).join("\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function answerToolCapabilityQuestion(userInput) {
  if (!/\b(what tools|which tools|tools.*access|access.*tools|how can you help)\b/i.test(userInput)) {
    return null;
  }

  return [
    `I can inspect the attached repository \`${getWorkspaceName()}\` through quiet-lab's read-only repo tools.`,
    "Useful things I can do here:",
    "- summarize the repository structure and likely stack",
    "- find entry points, package scripts, and dependency manifests",
    "- list folders, read selected files, and search repo text",
    "- read several bounded file excerpts at once",
    "- summarize imports, exports, functions, classes, routes, and CSS selectors",
    "I cannot edit files from inside this chat yet; these tools are inspection-only.",
  ].join("\n");
}

function answerMemoryQuestion(userInput, memory) {
  if (!/\b(memory|remember|remembered|known context|project notes)\b/i.test(userInput)) {
    return null;
  }

  if (!memory?.updatedAt) {
    return `I do not have stored project memory for \`${getWorkspaceName()}\` yet. Run Map repo, Review, Tests, or add notes in Control Center to build it.`;
  }

  const sections = [
    `Project memory for \`${memory.repoName}\`:`,
    memory.project.stack.length ? `Stack:\n${memory.project.stack.map((item) => `- ${item}`).join("\n")}` : null,
    memory.project.entrypoints.length ? `Entry points:\n${memory.project.entrypoints.slice(0, 12).map((item) => `- \`${item}\``).join("\n")}` : null,
    memory.project.packageScripts.length ? `Scripts:\n${memory.project.packageScripts.slice(0, 12).map((item) => `- ${item}`).join("\n")}` : null,
    memory.project.knownRisks.length ? `Known risks:\n${memory.project.knownRisks.slice(0, 12).map((item) => `- ${item}`).join("\n")}` : null,
    memory.project.recommendedTests.length ? `Recommended tests:\n${memory.project.recommendedTests.slice(0, 12).map((item) => `- ${item}`).join("\n")}` : null,
    memory.userNotes.length ? `User notes:\n${memory.userNotes.slice(0, 12).map((item) => `- ${item}`).join("\n")}` : null,
    `Updated: ${memory.updatedAt}.`,
  ].filter(Boolean);

  return sections.join("\n\n");
}

function answerFromBootstrap(userInput, bootstrapResults) {
  return (
    answerWorkspaceAttachmentQuestion(userInput) ||
    answerToolCapabilityQuestion(userInput) ||
    answerPackageJsonQuestion(userInput, bootstrapResults) ||
    answerRepoRiskQuestion(userInput, bootstrapResults) ||
    answerTestPlanQuestion(userInput, bootstrapResults) ||
    answerRepoOverviewQuestion(userInput, bootstrapResults) ||
    answerPromptFileQuestion(userInput, bootstrapResults) ||
    answerPresetQuestion(userInput, bootstrapResults) ||
    answerReadmeQuestion(userInput, bootstrapResults) ||
    answerCommitabilityQuestion(userInput, bootstrapResults)
  );
}

export function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    error?.code === 20 ||
    error?.code === "ABORT_ERR"
  );
}

async function requestRecoveryAnswer({ baseUrl, model, messagesForRequest, signal }) {
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
    signal,
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
  signal,
}) {
  let response;

  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model,
        stream,
        messages: messagesForRequest,
        ...(includeTools ? { tools: getEnabledToolDefinitions() } : {}),
      }),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    throw new Error(`Could not reach Ollama at ${baseUrl}. Make sure Ollama is running.`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${body}`);
  }

  if (!stream) {
    const data = await response.json();
    const content = data.message?.content?.trim() || "";
    const nativeToolCalls = data.message?.tool_calls || [];
    const contentToolCalls = nativeToolCalls.length ? [] : parseContentToolCalls(content);

    return {
      content: contentToolCalls.length ? "" : content,
      toolCalls: nativeToolCalls.length ? nativeToolCalls : contentToolCalls,
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

      let data;
      try {
        data = JSON.parse(line);
      } catch {
        continue;
      }

      const token = data.message?.content || "";

      if (token) {
        onToken(token);
        content += token;
      }
    }
  }

  if (buffer.trim()) {
    let data;
    try {
      data = JSON.parse(buffer.trim());
    } catch {
      data = null;
    }

    if (data) {
      const token = data.message?.content || "";

      if (token) {
        onToken(token);
        content += token;
      }
    }
  }

  return { content: content.trim(), toolCalls: [] };
}

function stripJsonFence(content) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseContentToolCalls(content) {
  if (!content || !/```|[\[{]/.test(content)) {
    return [];
  }

  const candidates = [stripJsonFence(content)];
  const fencedBlocks = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map((match) =>
    match[1].trim(),
  );
  candidates.push(...fencedBlocks);

  const objectBlocks = [...content.matchAll(/(^|\n)\s*(\{[\s\S]*?\})\s*(?=\n|$)/g)].map((match) =>
    match[2].trim(),
  );
  candidates.push(...objectBlocks);

  const parsedValues = [];

  for (const candidate of candidates) {
    try {
      parsedValues.push(JSON.parse(candidate));
    } catch {
      // Keep scanning; small local models often wrap valid tool JSON in prose.
    }
  }

  if (!parsedValues.length) {
    return [];
  }

  const values = parsedValues.flatMap((parsed) => (Array.isArray(parsed) ? parsed : [parsed]));
  const calls = [];
  const seen = new Set();

  for (const value of values) {
    const name = value?.function?.name || value?.name;
    const args = value?.function?.arguments ?? value?.arguments ?? {};

    if (typeof name !== "string" || !isToolEnabled(name)) {
      continue;
    }

    const normalizedArgs = args && typeof args === "object" ? args : {};
    const key = `${name}:${JSON.stringify(normalizedArgs)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    calls.push(buildToolCall(name, normalizedArgs));
  }

  return calls;
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

export function createSessionIdFromTitle(title) {
  const slug = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);

  return normalizeSessionId(slug || createSessionId());
}

async function createAvailableSessionId(baseSessionId) {
  const base = normalizeSessionId(baseSessionId);
  let candidate = base;

  for (let index = 2; index < 1000; index += 1) {
    try {
      await readFile(path.join(sessionsDir, `${candidate}.json`), "utf8");
      candidate = normalizeSessionId(`${base}-${index}`);
    } catch {
      return candidate;
    }
  }

  throw new Error("Could not create a unique session name.");
}

export class ChatSession {
  constructor({
    sessionId = "latest",
    model = defaultModel,
    preset = process.env.OLLAMA_PRESET || "coder",
    baseUrl = defaultBaseUrl,
    systemPromptOverride = null,
    title = null,
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
    this.title = title;
  }

  get filePath() {
    return path.join(sessionsDir, `${normalizeSessionId(this.sessionId)}.json`);
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      title: this.title || deriveSessionTitle(this.messages),
      model: this.model,
      baseUrl: this.baseUrl,
      preset: this.activePreset,
      basePrompt: this.basePrompt,
      systemPrompt: this.systemPrompt,
      repoName: hasAttachedCodebase() ? getWorkspaceName() : null,
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
      this.title = saved.title || this.title;

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

  async setCustomPreset(name, prompt, { resetHistory = true } = {}) {
    const cleanName = String(name || "custom").replace(/^custom:/, "").trim().slice(0, 48) || "custom";
    const cleanPrompt = String(prompt || "").trim();

    if (!cleanPrompt) {
      throw new Error("Custom preset prompt is required.");
    }

    this.activePreset = `custom:${cleanName}`;
    this.basePrompt = cleanPrompt;
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
      signal,
    } = {},
  ) {
    const turnStartLength = this.messages.length;
    this.messages.push({ role: "user", content: userInput });

    try {
      if (!shouldUseRepoTools(userInput, this.activePreset)) {
        const assistant = await requestAssistant({
          baseUrl: this.baseUrl,
          model: this.model,
          messagesForRequest: this.messages,
          stream: true,
          includeTools: false,
          onToken,
          signal,
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
      const projectMemory = await loadProjectMemory();
      const memoryContext = formatProjectMemoryContext(projectMemory);
      const memoryAnswer = answerMemoryQuestion(userInput, projectMemory);
      const bootstrapAnswer = memoryAnswer || answerFromBootstrap(userInput, bootstrapResults);

      if (bootstrapAnswer) {
        if (!memoryAnswer && this.model !== "no-network-needed") {
          await updateProjectMemoryFromBootstrap(userInput, bootstrapResults, bootstrapAnswer);
        }
        this.messages.push({ role: "assistant", content: bootstrapAnswer });
        await this.save();
        onFinal(bootstrapAnswer);
        return { text: bootstrapAnswer, toolEvents };
      }

      const { limits } = getToolRuntimeConfig();

      for (let round = 0; round < limits.maxToolRounds; round += 1) {
        const assistant = await requestAssistant({
          baseUrl: this.baseUrl,
          model: this.model,
          messagesForRequest: messagesWithBootstrapContext(this.messages, bootstrapContext, memoryContext),
          stream: false,
          includeTools: true,
          signal,
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
          ...messagesWithBootstrapContext(this.messages, bootstrapContext, memoryContext),
          {
            role: "system",
            content:
              "Answer now using the gathered repo evidence. Do not call tools again. If the evidence is incomplete, say exactly what is missing.",
          },
        ],
        stream: false,
        includeTools: false,
        signal,
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
        messagesForRequest: messagesWithBootstrapContext(this.messages, bootstrapContext, memoryContext),
        signal,
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
    } catch (error) {
      if (isAbortError(error)) {
        this.messages.length = turnStartLength;
        throw error;
      }

      throw error;
    }
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

export async function saveSessionAs(sourceSessionId, title) {
  const source = new ChatSession({ sessionId: sourceSessionId });
  const loaded = await source.load();

  if (!loaded) {
    throw new Error("Session not found.");
  }

  const cleanTitle = String(title || "").trim().replace(/\s+/g, " ");

  if (!cleanTitle) {
    throw new Error("Conversation name is required.");
  }

  const sessionId = await createAvailableSessionId(createSessionIdFromTitle(cleanTitle));
  const saved = new ChatSession({
    sessionId,
    model: source.model,
    preset: source.activePreset,
    baseUrl: source.baseUrl,
    title: cleanTitle,
  });

  saved.basePrompt = source.basePrompt;
  saved.systemPrompt = source.systemPrompt;
  saved.messages = source.messages;
  await saved.save();

  return saved.toJSON();
}

export async function deleteSession(sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  await rm(path.join(sessionsDir, `${normalizedSessionId}.json`), { force: true });
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
