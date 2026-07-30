import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSkillTools,
  discoverEnabledSkills,
  initSkillRuntime,
} from "./runtime.js";

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
