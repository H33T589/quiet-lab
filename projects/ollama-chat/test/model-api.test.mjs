import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelCatalogPayload } from "../server.mjs";

test("model catalog API payload marks installed Ollama recommendations", () => {
  const payload = createModelCatalogPayload([
    "phi4-mini:latest",
    "qwen2.5-coder:3b",
  ]);
  const byModel = new Map(payload.recommendedModels.map((model) => [model.model, model]));

  assert.deepEqual(payload.installedModels, ["phi4-mini:latest", "qwen2.5-coder:3b"]);
  assert.equal(byModel.get("phi4-mini").installed, true);
  assert.equal(byModel.get("qwen2.5-coder:3b").installed, true);
  assert.equal(byModel.get("llama3.2:3b").installed, false);
});
