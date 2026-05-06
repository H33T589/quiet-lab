/**
 * Named shortcuts that map to Ollama model tags. Server exposes built-ins;
 * the browser can add custom profiles in localStorage.
 */
export const builtInModelProfiles = [
  {
    id: "general",
    label: "General",
    description: "Reasoning, chat, and mixed tasks",
    model: "phi4-mini",
  },
  {
    id: "coding",
    label: "Coding",
    description: "Code-focused Q&A and repo work",
    model: "qwen2.5-coder:3b",
  },
  {
    id: "heavy",
    label: "Heavy",
    description: "Larger model when RAM allows",
    model: "qwen2.5:7b",
  },
];

export function pickAvailableModel(preferred, availableModels, fallback) {
  const list = Array.isArray(availableModels) ? availableModels : [];
  if (preferred && list.includes(preferred)) {
    return preferred;
  }

  if (preferred) {
    const prefix = preferred.split(":")[0];
    const partial = list.find((name) => name === preferred || name.startsWith(`${prefix}:`));
    if (partial) {
      return partial;
    }
  }

  return fallback || list[0] || preferred || "phi4-mini";
}

export function resolveProfileModel(profile, { availableModels, defaultModel }) {
  if (!profile?.model) {
    return defaultModel;
  }

  return pickAvailableModel(profile.model, availableModels, defaultModel);
}
