export const recommendedModels = [
  {
    id: "daily-chat",
    label: "Daily Chat",
    useCase: "Fast general conversation on most laptops",
    model: "llama3.2:3b",
    size: "3B",
    tags: ["general", "fast", "low memory"],
  },
  {
    id: "small-reasoning",
    label: "Small Reasoning",
    useCase: "Planning, summaries, and careful answers without a huge model",
    model: "phi4-mini",
    size: "3.8B",
    tags: ["reasoning", "balanced"],
  },
  {
    id: "coding-small",
    label: "Coding Small",
    useCase: "Repo questions, code edits, and local dev help",
    model: "qwen2.5-coder:3b",
    size: "3B",
    tags: ["coding", "tools", "low memory"],
  },
  {
    id: "coding-balanced",
    label: "Coding Balanced",
    useCase: "Stronger code generation when you have more RAM",
    model: "qwen2.5-coder:7b",
    size: "7B",
    tags: ["coding", "tools"],
  },
  {
    id: "reasoning",
    label: "Reasoning",
    useCase: "Step-by-step math, analysis, and hard prompts",
    model: "deepseek-r1:7b",
    size: "7B",
    tags: ["reasoning", "thinking"],
  },
  {
    id: "vision",
    label: "Vision",
    useCase: "Image understanding and multimodal chat",
    model: "gemma3:4b",
    size: "4B",
    tags: ["vision", "general"],
  },
  {
    id: "new-general",
    label: "New General",
    useCase: "Newer general model family with reasoning and multimodal variants",
    model: "gemma4:12b",
    size: "12B",
    tags: ["new", "vision", "tools", "thinking"],
  },
  {
    id: "new-coding",
    label: "New Coding",
    useCase: "Newer agentic coding model for larger local machines",
    model: "qwen3.6:27b",
    size: "27B",
    tags: ["new", "coding", "tools", "thinking"],
  },
];

export function isKnownRecommendedModel(model) {
  return recommendedModels.some((entry) => entry.model === model);
}

export function modelTagMatches(installedModel, requestedModel) {
  if (installedModel === requestedModel) {
    return true;
  }

  return !requestedModel.includes(":") && installedModel === `${requestedModel}:latest`;
}

export function isModelInstalled(model, installedModels) {
  return Array.isArray(installedModels)
    ? installedModels.some((installedModel) => modelTagMatches(installedModel, model))
    : false;
}
