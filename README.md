# local-ai-experiments

Small local AI workspace for models, notes, and experiments.

## Layout

- `models/`: local model storage and runtime-managed artifacts
- `notes/`: setup notes, prompts, and findings worth keeping
- `projects/`: scripts, prototypes, and small local AI experiments

## Ollama Storage

`Ollama` is configured to use this folder via the symlink at [`~/.ollama`](/Users/h33tpatel/.ollama), which points to [`models/.ollama/`](/Users/h33tpatel/Documents/local-ai-experiments/models/.ollama).

That directory is intentionally ignored by git because it contains downloaded models and runtime state.

## What To Commit

- notes you want to keep
- scripts and small tools in `projects/`
- setup docs such as this README

## What Not To Commit

- downloaded models
- `Ollama` runtime state
- secrets in `.env*`
- generated outputs, caches, and logs

## Suggested Next Steps

1. Keep your default local model small on this machine. On an `M2` with `8 GB` RAM, `llama3.2:3b` is the safer default.
2. Put reusable scripts in `projects/`.
3. Keep prompts, install notes, and benchmark results in `notes/`.
