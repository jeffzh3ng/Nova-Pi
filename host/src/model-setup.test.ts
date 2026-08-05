import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initModelRuntime, resolveModel, type HostModelSettings } from "./model-setup.js";

/**
 * resolveModel 配置覆盖测试。
 *
 * 关键回归点：前端 model_settings 的 max_tokens 必须覆盖到返回 Model 对象的
 * maxTokens 字段。pi 的 agent loop 调模型时不传 options.maxTokens，最终由
 * pi-ai 的 buildBaseOptions 用 `options?.maxTokens ?? model.maxTokens` 取值
 *（见 node_modules/@earendil-works/pi-ai/dist/api/simple-options.js）。
 * 若 resolveModel 不覆盖，前端配置被静默忽略，永远用 models.json 目录值
 *（如 deepseek-v4-pro 的 4096）。
 *
 * 用真实 ModelRuntime.create（临时 agentDir）做集成测试，验证覆盖逻辑在真实
 * runtime 解析路径上生效。
 */

const DEEPSEEK_DEFAULT_MAX_TOKENS = 4096; // models.json 里 deepseek-v4-pro 的目录值

async function withRuntime<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "nova-pi-model-setup-"));
  // 写入与生产一致的 models.json，提供 deepseek-v4-pro 目录项。
  writeFileSync(join(dir, "models.json"), JSON.stringify({
    providers: {
      deepseek: {
        name: "deepseek",
        baseUrl: "https://api.deepseek.com",
        api: "openai-completions",
        models: [{ id: "deepseek-v4-pro", contextWindow: 1000000, maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS, reasoning: true }],
      },
    },
  }));
  await initModelRuntime(dir);
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseSettings(overrides: Partial<HostModelSettings> = {}): HostModelSettings {
  return {
    provider: "deepseek",
    apiKey: "sk-test",
    baseUrl: "",
    model: "deepseek-v4-pro",
    temperature: 0.2,
    maxTokens: 12288,
    proxyUrl: "",
    ...overrides,
  };
}

test("resolveModel 把前端 maxTokens 覆盖到 model.maxTokens（不再被 models.json 的 4096 覆盖）", async () => {
  await withRuntime(async () => {
    const model = resolveModel(baseSettings({ maxTokens: 12288 }));
    assert.equal(model.maxTokens, 12288, `前端 maxTokens=12288 应覆盖到 model，实际 ${model.maxTokens}（说明被 models.json 的 ${DEEPSEEK_DEFAULT_MAX_TOKENS} 占了）`);
  });
});

test("resolveModel 不传 maxTokens 时沿用 models.json 目录值", async () => {
  await withRuntime(async () => {
    const model = resolveModel(baseSettings({ maxTokens: 0 }));
    assert.equal(model.maxTokens, DEEPSEEK_DEFAULT_MAX_TOKENS, `maxTokens=0（无效）时应回退到目录值 ${DEEPSEEK_DEFAULT_MAX_TOKENS}，实际 ${model.maxTokens}`);
  });
});

test("resolveModel 覆盖 baseUrl（指向自建网关）", async () => {
  await withRuntime(async () => {
    const custom = "https://my-deepseek-gateway.example.com";
    const model = resolveModel(baseSettings({ baseUrl: custom }));
    assert.equal(model.baseUrl, custom, `前端 baseUrl 应覆盖到 model.baseUrl，实际 ${model.baseUrl}`);
  });
});

test("resolveModel 覆盖 maxTokens 同时保留 baseUrl 覆盖（两者独立生效）", async () => {
  await withRuntime(async () => {
    const custom = "https://gw.example.com";
    const model = resolveModel(baseSettings({ baseUrl: custom, maxTokens: 8192 }));
    assert.equal(model.maxTokens, 8192);
    assert.equal(model.baseUrl, custom);
  });
});

test("resolveModel 对 openai-compatible 自定义模型同样应用 maxTokens 覆盖", async () => {
  await withRuntime(async () => {
    const model = resolveModel(baseSettings({
      provider: "openai-compatible",
      model: "my-custom-model",
      baseUrl: "https://api.openai.com/v1",
      maxTokens: 16384,
    }));
    assert.equal(model.maxTokens, 16384, `openai-compatible 模型也应覆盖 maxTokens，实际 ${model.maxTokens}`);
  });
});
