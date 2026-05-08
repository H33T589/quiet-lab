# quiet-lab

A small workspace for running local models, keeping notes, and building lightweight experiments on top of `Ollama`.

## Overview

This repository is organized around three things:

- `models/` for local model storage and runtime-managed data
- `notes/` for prompts, setup notes, and findings worth keeping
- `projects/` for scripts, prototypes, and small apps

The goal is to keep code and notes in git while keeping downloaded model data out of git.

## Layout

- `models/`: local model storage and runtime-managed artifacts
- `notes/`: setup notes, prompts, and findings worth keeping
- `projects/`: scripts, prototypes, and small local AI experiments

## Ollama Storage

`Ollama` can be pointed at `models/.ollama/` so model downloads and runtime state stay inside this workspace.

That directory is intentionally ignored by git because it contains downloaded models, local keys, and runtime state.

## Quick Start

1. Install and start `Ollama`.
2. Pull a small default model such as `phi4-mini` (or `qwen2.5-coder:3b` for code-heavy work).
3. Use the starter app in `projects/ollama-chat/` to talk to the local API.

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

1. Keep your default local model small on memory-constrained machines. `phi4-mini` is a strong default; see `projects/ollama-chat/README.md` for `OLLAMA_MODEL`.
2. Put reusable scripts in `projects/`.
3. Keep prompts, install notes, and benchmark results in `notes/`.

## Starter App

A local `Ollama` starter app lives in [`projects/ollama-chat/`](./projects/ollama-chat) with both:

- a minimal CLI chat workflow
- a browser UI with sessions, repo browsing, tool activity, and project memory

It talks to the local `Ollama` HTTP API directly and is a good baseline before you build anything more agentic.

See:
- [Run + Browser UI](./projects/ollama-chat/README.md#run)
- [Environment](./projects/ollama-chat/README.md#environment)
- [Repo Tools](./projects/ollama-chat/README.md#repo-tools)
