import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSkillTools,
  discoverEnabledSkills,
  formatMcpInventoryForPrompt,
  initSkillRuntime,
} from "./runtime.js";
import type { RegisteredMcpTool } from "../mcp/registry.js";

test("Skill runtime honors enable state and restricts reads/execution to the installed package", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nova-skill-runtime-"));
  const agentDir = path.join(root, "agent");
  const skillDir = path.join(agentDir, "skills", "runtime-test");
  const statePath = path.join(root, "skill-state.json");
  mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---
name: runtime-test
description: Test Skill runtime discovery, reading and script execution.
metadata:
  test:
    requires:
      bins: [python3]
---

# Runtime test
`,
  );
  writeFileSync(
    path.join(skillDir, "scripts", "hello.py"),
    "import json, os, sys\nprint(json.dumps({'message': sys.argv[1], 'ca_file': os.environ.get('SSL_CERT_FILE', '')}, ensure_ascii=False))\n",
  );
  writeFileSync(statePath, JSON.stringify({ disabledSkillIds: [] }));
  initSkillRuntime(agentDir, [], statePath);

  try {
    assert.deepEqual(discoverEnabledSkills().map((skill) => skill.name), ["runtime-test"]);
    const tools = createSkillTools();
    const readTool = tools.find((tool) => tool.name === "skill_read");
    const executeTool = tools.find((tool) => tool.name === "skill_execute");
    assert.ok(readTool);
    assert.ok(executeTool);

    const readResult = await readTool.execute(
      "read",
      { skillName: "runtime-test" } as never,
      undefined,
      undefined,
      {} as never,
    );
    assert.match(readResult.content[0]?.type === "text" ? readResult.content[0].text : "", /Runtime test/);

    await assert.rejects(
      readTool.execute(
        "escape",
        { skillName: "runtime-test", relativePath: "../outside.txt" } as never,
        undefined,
        undefined,
        {} as never,
      ),
      /超出 Skill 目录/,
    );

    const executeResult = await executeTool.execute(
      "execute",
      {
        skillName: "runtime-test",
        command: "scripts/hello.py",
        arguments: ["真实执行"],
      } as never,
      undefined,
      undefined,
      {} as never,
    );
    const executeText = executeResult.content[0]?.type === "text" ? executeResult.content[0].text : "";
    assert.match(executeText, /真实执行/);
    if (existsSync("/etc/ssl/cert.pem")) {
      assert.match(executeText, /\/etc\/ssl\/cert\.pem/);
    }

    writeFileSync(statePath, JSON.stringify({ disabledSkillIds: ["runtime-test"] }));
    assert.deepEqual(discoverEnabledSkills(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTool(
  overrides: Partial<RegisteredMcpTool["tool"]> & { name: string; serviceId?: string },
): RegisteredMcpTool {
  const { serviceId, name, ...rest } = overrides;
  return {
    serviceId: serviceId ?? "alert-analysis-mcp",
    // server 字段不被 formatMcpInventoryForPrompt 读取，测试里置空即可。
    server: null as never,
    tool: {
      name,
      description: rest.description,
      title: rest.title,
      inputSchema: rest.inputSchema ?? { type: "object", properties: {}, required: [] },
    } as RegisteredMcpTool["tool"],
  };
}

test("formatMcpInventoryForPrompt 在空工具/空错误时返回空字符串", () => {
  assert.equal(formatMcpInventoryForPrompt([], []), "");
});

test("formatMcpInventoryForPrompt 列出工具、参数与必填标注", () => {
  const tools = [
    makeTool({
      serviceId: "alert-analysis-mcp",
      name: "analyze_security_alert",
      description: "Test tool: analyze_security_alert OCR",
      inputSchema: {
        type: "object",
        properties: {
          alertText: { type: "string" },
          pcapFilePath: { type: "string" },
        },
        required: ["alertText"],
      },
    }),
    makeTool({
      serviceId: "alert-analysis-mcp",
      name: "analyze_attack_ip",
      description: "Test tool: analyze_attack_ip",
      inputSchema: { type: "object", properties: { ip: { type: "string" } } },
    }),
  ];
  const text = formatMcpInventoryForPrompt(tools, []);
  assert.match(text, /共 2 个/);
  // 完整 serviceId/toolName 形式可被 agent 直接复用为 tool 参数。
  assert.match(text, /alert-analysis-mcp\/analyze_security_alert：Test tool: analyze_security_alert OCR/);
  // 必填标注 + 类型；未在 required 列表中的 pcapFilePath 不带「必填」。
  assert.match(text, /alertText\(string,必填\), pcapFilePath\(string\)/);
  assert.match(text, /analyze_attack_ip：Test tool: analyze_attack_ip/);
  assert.match(text, /ip\(string\)/);
});

test("formatMcpInventoryForPrompt 对超长描述进行截断", () => {
  const longDescription = "描述".repeat(200); // 远超 120 字符
  const tools = [makeTool({ name: "big_tool", description: longDescription })];
  const text = formatMcpInventoryForPrompt(tools, []);
  // 截断发生在第 120 个字符处；正文不应包含完整长描述。
  assert.doesNotMatch(text, new RegExp(longDescription));
  // 仍包含工具名。
  assert.match(text, /alert-analysis-mcp\/big_tool/);
});

test("formatMcpInventoryForPrompt 把失败服务以重试提示形式拼接", () => {
  const text = formatMcpInventoryForPrompt([], [
    { serviceId: "offline-mcp", error: "connection refused\nmore detail" },
  ]);
  assert.match(text, /下列服务本次握手超时或失败/);
  assert.match(text, /offline-mcp：connection refused more detail/);
});

test("formatMcpInventoryForPrompt 同时呈现就绪工具与失败服务", () => {
  const tools = [makeTool({ serviceId: "ok-mcp", name: "do_thing", description: "可用的工具" })];
  const errors = [{ serviceId: "bad-mcp", error: "timeout" }];
  const text = formatMcpInventoryForPrompt(tools, errors);
  assert.match(text, /ok-mcp\/do_thing：可用的工具/);
  assert.match(text, /bad-mcp：timeout/);
});
