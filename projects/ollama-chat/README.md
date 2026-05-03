# ollama-chat

Minimal zero-dependency CLI chat app for the local `Ollama` API.

It now supports:

- streamed replies
- auto-saved local session history
- preset system prompts for different modes
- read-only repository tools for file listing, file reading, and search
- configurable tool profiles and resource budgets for smaller local models
- stricter grounded answers for repo questions
- a local browser UI with sessions, repo browsing, and tool activity

## Run

```bash
cd projects/ollama-chat
npm start
```

Use a specific model:

```bash
npm start -- qwen2.5:7b
```

Use a specific preset:

```bash
npm start -- --preset summarize
```

Run the browser UI:

```bash
npm run web
```

Then open:

```text
http://127.0.0.1:4317
```

## Environment

- `OLLAMA_MODEL`: default model if no CLI arg is passed
- `OLLAMA_BASE_URL`: defaults to `http://127.0.0.1:11434`
- `OLLAMA_CHAT_HOST`: defaults to `127.0.0.1`
- `OLLAMA_CHAT_PORT`: defaults to `4317`
- `OLLAMA_SYSTEM`: optional system prompt
- `OLLAMA_PRESET`: default preset if no CLI preset is passed
- `OLLAMA_TOOL_PROFILE`: `minimal`, `coding`, or `deep`; defaults to `coding`
- `OLLAMA_RESOURCE_BUDGET`: `low`, `balanced`, or `expanded`; defaults to the profile budget

## Commands

- `/reset`: clear the current chat history
- `/preset NAME`: switch presets and clear the current chat history
- `/presets`: list the available presets
- `/tools`: list the available repo tools
- `/status`: show the current model, preset, and session location
- `/exit`: quit

## Browser UI

The browser UI is served locally from `server.mjs` and adds:

- session sidebar
- model and preset controls
- streamed chat panel
- tool activity inspector
- attach-codebase flow for selecting a local folder from the UI
- repo tree and file preview for the attached codebase
- repo filtering, quick prompts, and selected-file prompt helpers

It reuses the same local repo-aware backend logic as the CLI.

On first launch, attach a codebase from the Repository panel by pasting a local folder path. Recent codebases are remembered locally for reuse. The web API includes the active `repoName` (workspace folder name) in session payloads, not the absolute repository path. Recent-codebase paths are exposed only through the local workspace endpoint used by the attach dialog.

Run `npm test` from this directory; GitHub Actions runs these tests on pushes and pull requests to `main`.

## Presets

- `coder`: concise coding help
- `brainstorm`: generate and compare ideas
- `repo`: read-only repo inspection and codebase Q&A
- `summarize`: compact summaries and distillation
- `tutor`: step-by-step explanations

## Repo Tools

The model can use a small set of read-only tools inside the attached codebase:

- `get_repo_overview`
- `find_entrypoints`
- `inspect_dependencies`
- `list_repo_files`
- `read_many_files`
- `read_repo_file`
- `search_repo`
- `summarize_file_symbols`

These tools are intentionally limited to the attached repository root. They do not write files, run shell commands, or access hidden folders such as `.git`, `.vscode`, `.idea`, `node_modules`, and common generated output directories.

Tooling is now routed through profiles and resource budgets so small Ollama models do not receive every possible tool or oversized results. The default `coding` profile keeps all current repo tools available but uses the `low` budget:

- `minimal`: file listing and file reading only
- `coding`: file listing, file reading, and search
- `deep`: all repo tools with a larger context budget

Budgets cap tool rounds, preloaded context, directory entries, file lines, and search results. The browser backend exposes `/api/tooling` so a future settings panel can switch profiles without changing the model-facing architecture.

For repo questions, the CLI now hides the model's pre-tool chatter and only shows explicit tool calls plus the grounded answer. This reduces fake shell-style narration and makes wrong inferences easier to spot.

## Session History

Session state is saved locally to `projects/ollama-chat/sessions/latest.json`.

That directory is ignored by git and is meant for local use only.

## Notes

On memory-constrained machines, start with `llama3.2:3b` as the default.

If you are using different hardware, adjust the model choice accordingly.
