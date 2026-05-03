import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatSession } from "./engine.mjs";
import { listPresets } from "./presets.mjs";
import { attachCodebase, getWorkspaceSnapshot, listTools } from "./tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const presetArgIndex = args.indexOf("--preset");
const explicitPresetName = (presetArgIndex >= 0 ? args[presetArgIndex + 1] : null) ||
  process.env.OLLAMA_PRESET ||
  null;
const presetName = explicitPresetName || "coder";
const modelArg = args.find((arg, index) => {
  if (!arg || arg.startsWith("--")) {
    return false;
  }

  if (presetArgIndex >= 0 && index === presetArgIndex + 1) {
    return false;
  }

  return true;
});

const model = modelArg || process.env.OLLAMA_MODEL || "llama3.2:3b";
const explicitModel = modelArg || process.env.OLLAMA_MODEL || null;
const rl = readline.createInterface({ input, output });

function printToolCall(call) {
  const argsText = JSON.stringify(call.function.arguments || {});
  console.log(`\n[tool] ${call.function.name} ${argsText}`);
}

async function main() {
  const workspace = await attachCodebase(
    process.env.OLLAMA_REPO_ROOT || path.resolve(__dirname, "../.."),
  );
  const session = new ChatSession({
    sessionId: process.env.OLLAMA_SESSION || "latest",
    model,
    preset: presetName,
    systemPromptOverride: process.env.OLLAMA_SYSTEM || null,
  });

  const loaded = await session.load();

  if (explicitModel && explicitModel !== session.model) {
    await session.setModel(explicitModel);
  }

  if (!process.env.OLLAMA_SYSTEM && explicitPresetName && explicitPresetName !== session.activePreset) {
    await session.setPreset(explicitPresetName, { resetHistory: false });
  }

  console.log(`Using model: ${session.model}`);
  console.log(`Ollama endpoint: ${session.baseUrl}`);
  console.log(`Preset: ${session.activePreset}`);
  console.log(`Repo: ${workspace.repoName}`);
  if (loaded) {
    console.log(`Loaded session: sessions/${session.sessionId}.json`);
  }
  console.log(
    "Type a prompt. Commands: /reset, /preset NAME, /presets, /tools, /status, /exit.\n",
  );

  while (true) {
    let userInput;

    try {
      userInput = (await rl.question("> ")).trim();
    } catch (error) {
      if (error?.code === "ERR_USE_AFTER_CLOSE" || error?.code === "ABORT_ERR") {
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
      await session.reset();
      console.log("Chat history cleared.\n");
      continue;
    }

    if (userInput === "/presets") {
      console.log(`Available presets: ${listPresets().join(", ")}\n`);
      continue;
    }

    if (userInput === "/tools") {
      console.log(`${listTools()}\n`);
      continue;
    }

    if (userInput === "/status") {
      console.log(
        `Model: ${session.model}\nPreset: ${session.activePreset}\nRepo: ${getWorkspaceSnapshot().repoName || "none"}\nMessages: ${Math.max(session.messages.length - 1, 0)}\nSession: sessions/${session.sessionId}.json\n`,
      );
      continue;
    }

    if (userInput.startsWith("/preset ")) {
      const nextPreset = userInput.slice("/preset ".length).trim();

      try {
        await session.setPreset(nextPreset, { resetHistory: true });
        console.log(`Switched preset to ${nextPreset} and cleared chat history.\n`);
      } catch (error) {
        console.log(`${error.message}\n`);
      }
      continue;
    }

    if (userInput.startsWith("/")) {
      console.log(
        "Unknown command. Supported commands: /reset, /preset NAME, /presets, /tools, /status, /exit.\n",
      );
      continue;
    }

    try {
      output.write("\n");
      let sawTokens = false;

      await session.chat(userInput, {
        onToken(token) {
          sawTokens = true;
          output.write(token);
        },
        onToolCall(call) {
          printToolCall(call);
        },
        onFinal(text) {
          if (!sawTokens) {
            output.write(`${text}`);
          }
        },
      });

      output.write("\n\n");
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
