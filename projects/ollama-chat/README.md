# ollama-chat

Minimal zero-dependency CLI chat app for the local `Ollama` API.

## Run

```bash
cd projects/ollama-chat
npm start
```

Use a specific model:

```bash
npm start -- qwen2.5:7b
```

## Environment

- `OLLAMA_MODEL`: default model if no CLI arg is passed
- `OLLAMA_BASE_URL`: defaults to `http://127.0.0.1:11434`
- `OLLAMA_SYSTEM`: optional system prompt

## Commands

- `/reset`: clear the current chat history
- `/exit`: quit

## Notes

On this machine, start with `llama3.2:3b` as the default. It is the safer fit for an `M2` MacBook Pro with `8 GB` RAM.

If you are using different hardware, adjust the model choice accordingly.
