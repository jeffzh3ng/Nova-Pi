import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  getDefaultModel,
  initModelsManagerPaths,
  listProviders,
  loginOAuthProvider,
  removeProvider,
  upsertProvider,
} from "./models-manager.js";

const runtime = {
  setRuntimeApiKey: () => undefined,
} as unknown as ModelRuntime;

test("the first provider becomes default while later providers preserve it", async () => {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), "nova-pi-models-"));
  try {
    initModelsManagerPaths(agentDir);
    assert.equal(await getDefaultModel(), null);

    const firstDefault = await upsertProvider(runtime, {
      id: "first-provider",
      name: "First Provider",
      baseUrl: "https://first.example.com/v1",
      api: "openai-completions",
      apiKey: "first-key",
      models: [
        { id: "first-model" },
        { id: "second-model" },
      ],
    });
    assert.deepEqual(firstDefault, { provider: "first-provider", model: "first-model" });
    assert.deepEqual(await getDefaultModel(), firstDefault);

    const secondDefault = await upsertProvider(runtime, {
      id: "second-provider",
      name: "Second Provider",
      baseUrl: "https://second.example.com/v1",
      api: "openai-completions",
      apiKey: "second-key",
      models: [{ id: "another-model" }],
    });
    assert.equal(secondDefault, null);
    assert.deepEqual(await getDefaultModel(), firstDefault);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("OpenAI Codex OAuth is exposed as a provider and becomes the first default", async () => {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), "nova-pi-codex-"));
  let loggedIn = false;
  let loggedOut = false;
  const codexModel = {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  };
  const oauthRuntime = {
    getProvider: () => ({
      id: "openai-codex",
      name: "OpenAI Codex",
      baseUrl: "https://chatgpt.com/backend-api",
      auth: { oauth: {} },
    }),
    getModels: () => [codexModel],
    getAvailable: async () => [codexModel],
    hasConfiguredAuth: () => loggedIn,
    login: async () => {
      loggedIn = true;
      return { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
    },
    logout: async () => {
      loggedIn = false;
      loggedOut = true;
    },
  } as unknown as ModelRuntime;

  try {
    initModelsManagerPaths(agentDir);
    const selected = await loginOAuthProvider(oauthRuntime, "openai-codex", "gpt-5.5", {
      prompt: async () => "browser",
      notify: () => undefined,
    });
    assert.deepEqual(selected, { provider: "openai-codex", model: "gpt-5.5" });
    assert.deepEqual(await getDefaultModel(), selected);

    const providers = await listProviders(oauthRuntime);
    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.id, "openai-codex");
    assert.equal(providers[0]?.authType, "oauth");
    assert.equal(providers[0]?.hasApiKey, false);
    assert.equal(providers[0]?.available, true);

    assert.equal(await removeProvider(oauthRuntime, "openai-codex"), true);
    assert.equal(loggedOut, true);
    assert.equal(await getDefaultModel(), null);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
