import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const model = process.argv[2] || process.env.OLLAMA_MODEL || "llama3.2:3b";
const baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const systemPrompt =
  process.env.OLLAMA_SYSTEM ||
  "You are a concise local coding assistant. Be direct and useful.";

const rl = readline.createInterface({ input, output });
const messages = [{ role: "system", content: systemPrompt }];

async function chat(userInput) {
  messages.push({ role: "user", content: userInput });

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const reply = data.message?.content?.trim() || "";
  messages.push({ role: "assistant", content: reply });
  return reply;
}

async function main() {
  console.log(`Using model: ${model}`);
  console.log(`Ollama endpoint: ${baseUrl}`);
  console.log("Type a prompt. Use /exit to quit and /reset to clear chat history.\n");

  while (true) {
    let userInput;

    try {
      userInput = (await rl.question("> ")).trim();
    } catch (error) {
      if (error?.code === "ERR_USE_AFTER_CLOSE") {
        break;
      }

      throw error;
    }

    if (!userInput) {
      continue;
    }

    if (userInput === "/exit") {
      break;
    }

    if (userInput === "/reset") {
      messages.splice(1);
      console.log("Chat history cleared.\n");
      continue;
    }

    try {
      const reply = await chat(userInput);
      console.log(`\n${reply}\n`);
    } catch (error) {
      console.error(`\n${error.message}\n`);
    }
  }

  if (!rl.closed) {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
