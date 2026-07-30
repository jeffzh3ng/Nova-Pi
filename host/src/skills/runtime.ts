import { spawn, execFile } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  loadSkills,
  parseFrontmatter,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_SKILL_OUTPUT_BYTES = 512 * 1024;
const MAX_SKILL_ARGUMENT_BYTES = 128 * 1024;
const SKILL_EXECUTION_TIMEOUT_MS = 120_000;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const READABLE_SKILL_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
]);

type SkillRegistryState = {
  disabledSkillIds?: string[];
};

type SkillRequirements = {
  bins: string[];
  env: string[];
};

export type SkillSummary = {
  name: string;
  description: string;
  location: string;
  requiredPrograms: string[];
  requiredEnvironment: Array<{ name: string; configured: boolean }>;
};

type EncryptedValue = {
  iv: string;
  ciphertext: string;
  tag: string;
};

type EncryptedEnvironmentDocument = {
  version: 1;
  values: Record<string, EncryptedValue>;
};

let configuredAgentDir = "";
let configuredAdditionalSkillPaths: string[] = [];
let configuredSkillStatePath = "";

export function initSkillRuntime(
  agentDir: string,
  additionalSkillPaths: string[],
  skillStatePath: string,
): void {
  configuredAgentDir = path.resolve(agentDir);
  configuredAdditionalSkillPaths = additionalSkillPaths
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
  configuredSkillStatePath = skillStatePath.trim()
    ? path.resolve(skillStatePath)
    : path.resolve(configuredAgentDir, "..", "..", "skill-state.json");
}

function assertConfigured(): void {
  if (!configuredAgentDir) {
    throw new Error("Skill 运行时尚未初始化。");
  }
}

function readDisabledSkillIds(): Set<string> {
  if (!configuredSkillStatePath) return new Set();
  try {
    const raw = readFileSync(configuredSkillStatePath, "utf8");
    const state = JSON.parse(raw) as SkillRegistryState;
    return new Set(
      (Array.isArray(state.disabledSkillIds) ? state.disabledSkillIds : [])
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function skillManifestId(skill: Skill): string {
  const manifestPath = path.join(skill.baseDir, "skill.json");
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { id?: unknown };
    if (typeof parsed.id === "string" && parsed.id.trim()) return parsed.id.trim();
  } catch {
    // Standard Agent Skills intentionally do not require skill.json.
  }
  return skill.name;
}

export function discoverEnabledSkills(cwd = process.cwd()): Skill[] {
  assertConfigured();
  const disabled = readDisabledSkillIds();
  const result = loadSkills({
    cwd,
    agentDir: configuredAgentDir,
    skillPaths: configuredAdditionalSkillPaths,
    includeDefaults: true,
  });
  return result.skills.filter((skill) => (
    !disabled.has(skill.name) && !disabled.has(skillManifestId(skill))
  ));
}

export function filterEnabledSkills<T extends { name: string; baseDir?: string }>(
  skills: T[],
): T[] {
  const disabled = readDisabledSkillIds();
  return skills.filter((skill) => {
    const manifestId = skill.baseDir
      ? skillManifestId(skill as unknown as Skill)
      : skill.name;
    return !disabled.has(skill.name) && !disabled.has(manifestId);
  });
}

function findEnabledSkill(name: string): Skill {
  const requested = name.trim();
  if (!requested) throw new Error("Skill 名称不能为空。");
  const skills = discoverEnabledSkills();
  const exact = skills.find((skill) => skill.name === requested || skillManifestId(skill) === requested);
  if (exact) return exact;
  throw new Error(`Skill 未安装、未启用或未获当前会话授权：${requested}`);
}

function collectStringValues(value: unknown, output: Set<string>, pattern?: RegExp): void {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized && (!pattern || pattern.test(normalized))) output.add(normalized);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, output, pattern);
  }
}

function collectRequirements(value: unknown, result: { bins: Set<string>; env: Set<string> }): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectRequirements(item, result);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "bins") {
      collectStringValues(nested, result.bins);
    } else if (normalizedKey === "env") {
      collectStringValues(nested, result.env, ENV_NAME_PATTERN);
    } else if (normalizedKey === "primaryenv") {
      collectStringValues(nested, result.env, ENV_NAME_PATTERN);
    }
    collectRequirements(nested, result);
  }
}

async function requirementsForSkill(skill: Skill): Promise<SkillRequirements> {
  const raw = await readFile(skill.filePath, "utf8");
  const { frontmatter } = parseFrontmatter(raw);
  const result = { bins: new Set<string>(), env: new Set<string>() };
  collectRequirements(frontmatter, result);
  return {
    bins: [...result.bins].sort(),
    env: [...result.env].sort(),
  };
}

function environmentAccount(skillName: string, envName: string): string {
  return `${skillName}\u0000${envName}`;
}

class SkillEnvironmentStore {
  private readonly documentPath: string;
  private readonly fallbackKeyPath: string;
  private masterKeyPromise: Promise<Buffer> | null = null;

  constructor(agentDir: string) {
    this.documentPath = path.join(agentDir, "skill-environment.json");
    this.fallbackKeyPath = path.join(agentDir, "skill-environment.key");
  }

  private async readDocument(): Promise<EncryptedEnvironmentDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.documentPath, "utf8")) as EncryptedEnvironmentDocument;
      if (parsed?.version !== 1 || !parsed.values || typeof parsed.values !== "object") {
        throw new Error("unsupported Skill environment document");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, values: {} };
      }
      throw new Error(`Skill 环境配置损坏，无法读取：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async has(account: string): Promise<boolean> {
    const document = await this.readDocument();
    return Object.hasOwn(document.values, account);
  }

  async set(account: string, value: string): Promise<void> {
    if (!value) throw new Error("环境变量值不能为空。");
    const key = await this.masterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const document = await this.readDocument();
    document.values[account] = {
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    await this.writeDocument(document);
  }

  async get(account: string): Promise<string | null> {
    const document = await this.readDocument();
    const stored = document.values[account];
    if (!stored) return null;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        await this.masterKey(),
        Buffer.from(stored.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(stored.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Skill 环境配置无法解密，请重新配置该变量。");
    }
  }

  private async writeDocument(document: EncryptedEnvironmentDocument): Promise<void> {
    await mkdir(path.dirname(this.documentPath), { recursive: true });
    const temporary = `${this.documentPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => {});
    await rename(temporary, this.documentPath);
    await chmod(this.documentPath, 0o600).catch(() => {});
  }

  private masterKey(): Promise<Buffer> {
    this.masterKeyPromise ??= this.loadOrCreateMasterKey();
    return this.masterKeyPromise;
  }

  private async loadOrCreateMasterKey(): Promise<Buffer> {
    if (process.platform === "darwin") {
      return this.loadOrCreateMacKeychainKey();
    }
    // Windows app-data and Linux user config directories inherit per-user ACLs.
    // The random AES key is additionally restricted to mode 0600 where supported.
    try {
      const existing = Buffer.from((await readFile(this.fallbackKeyPath, "utf8")).trim(), "base64");
      if (existing.length === 32) return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const generated = randomBytes(32);
    await mkdir(path.dirname(this.fallbackKeyPath), { recursive: true });
    await writeFile(this.fallbackKeyPath, `${generated.toString("base64")}\n`, { mode: 0o600 });
    await chmod(this.fallbackKeyPath, 0o600).catch(() => {});
    return generated;
  }

  private async loadOrCreateMacKeychainKey(): Promise<Buffer> {
    const security = "/usr/bin/security";
    const service = "com.nova.app.skill-environment";
    const account = "master-key-v1";
    try {
      const { stdout } = await execFileAsync(
        security,
        ["find-generic-password", "-a", account, "-s", service, "-w"],
        { timeout: 10_000, encoding: "utf8" },
      );
      const existing = Buffer.from(stdout.trim(), "base64");
      if (existing.length === 32) return existing;
    } catch {
      // Missing entry: create it below. Other failures surface if creation also fails.
    }
    const generated = randomBytes(32);
    await execFileAsync(
      security,
      [
        "add-generic-password",
        "-a",
        account,
        "-s",
        service,
        "-w",
        generated.toString("base64"),
        "-U",
      ],
      { timeout: 10_000, encoding: "utf8" },
    );
    return generated;
  }
}

function environmentStore(): SkillEnvironmentStore {
  assertConfigured();
  return new SkillEnvironmentStore(configuredAgentDir);
}

async function skillSummary(skill: Skill): Promise<SkillSummary> {
  const requirements = await requirementsForSkill(skill);
  const store = environmentStore();
  return {
    name: skill.name,
    description: skill.description,
    location: skill.filePath,
    requiredPrograms: requirements.bins,
    requiredEnvironment: await Promise.all(
      requirements.env.map(async (name) => ({
        name,
        configured: await store.has(environmentAccount(skill.name, name)),
      })),
    ),
  };
}

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function safeEnvironment(configured: Record<string, string>): NodeJS.ProcessEnv {
  const inheritedNames = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "SYSTEMROOT",
    "WINDIR",
  ];
  const inherited: NodeJS.ProcessEnv = Object.fromEntries(
    inheritedNames
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  // Python framework builds on macOS are frequently installed without running
  // "Install Certificates.command". In that state urllib fails against every
  // HTTPS Skill even though macOS already provides a current CA bundle.
  // Supply a known system bundle without weakening TLS verification. The same
  // values cover urllib/OpenSSL, requests and curl-based Skill scripts.
  const caFile = inherited.SSL_CERT_FILE || [
    "/etc/ssl/cert.pem",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
  ].find((candidate) => existsSync(candidate));
  if (caFile) {
    inherited.SSL_CERT_FILE ||= caFile;
    inherited.REQUESTS_CA_BUNDLE ||= caFile;
    inherited.CURL_CA_BUNDLE ||= caFile;
  }
  return { ...inherited, ...configured };
}

function redactSecrets(text: string, secrets: string[]): string {
  return secrets.reduce(
    (current, secret) => secret ? current.split(secret).join("[REDACTED]") : current,
    text,
  );
}

async function resolveSkillCommand(
  skill: Skill,
  requirements: SkillRequirements,
  requestedCommand: string,
  requestedArguments: string[],
): Promise<{ executable: string; args: string[] }> {
  const command = requestedCommand.trim();
  if (!command) throw new Error("Skill 执行命令不能为空。");
  if (!command.includes("/") && !command.includes("\\")) {
    if (!requirements.bins.includes(command)) {
      throw new Error(
        `Skill 未声明程序 ${command}；已声明程序：${requirements.bins.join("、") || "无"}`,
      );
    }
    return { executable: command, args: requestedArguments };
  }

  const baseDir = await realpath(skill.baseDir);
  const requestedPath = path.resolve(baseDir, command);
  const scriptPath = await realpath(requestedPath).catch(() => "");
  const scriptsRoot = path.join(baseDir, "scripts");
  if (
    !scriptPath
    || (scriptPath !== scriptsRoot && !scriptPath.startsWith(`${scriptsRoot}${path.sep}`))
  ) {
    throw new Error("Skill 只能执行自身 scripts 目录中的脚本。");
  }
  const metadata = await stat(scriptPath);
  if (!metadata.isFile()) throw new Error("Skill 执行目标不是普通文件。");
  const extension = path.extname(scriptPath).toLowerCase();
  if (extension === ".py") {
    return {
      executable: process.platform === "win32" ? "py" : "python3",
      args: [...(process.platform === "win32" ? ["-3"] : []), scriptPath, ...requestedArguments],
    };
  }
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return { executable: process.execPath, args: [scriptPath, ...requestedArguments] };
  }
  throw new Error(`Skill 脚本类型不受支持：${extension || "无扩展名"}`);
}

async function runSkillProcess(
  skill: Skill,
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const requirements = await requirementsForSkill(skill);
  const argumentBytes = args.reduce((total, item) => total + Buffer.byteLength(item), 0);
  if (args.length > 64 || argumentBytes > MAX_SKILL_ARGUMENT_BYTES) {
    throw new Error("Skill 执行参数过多或过长。");
  }
  const store = environmentStore();
  const configured: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of requirements.env) {
    const value = await store.get(environmentAccount(skill.name, name));
    if (value) configured[name] = value;
    else missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `Skill 缺少环境配置：${missing.join("、")}。请先调用 skill_configure_environment。`,
    );
  }

  const resolved = await resolveSkillCommand(skill, requirements, command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.executable, resolved.args, {
      cwd: skill.baseDir,
      env: safeEnvironment(configured),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let finished = false;
    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      if (outputBytes >= MAX_SKILL_OUTPUT_BYTES) return;
      const text = chunk.toString();
      const remaining = MAX_SKILL_OUTPUT_BYTES - outputBytes;
      const clipped = Buffer.from(text).subarray(0, remaining).toString();
      outputBytes += Buffer.byteLength(clipped);
      if (target === "stdout") stdout += clipped;
      else stderr += clipped;
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const stop = () => {
      if (!finished) child.kill();
    };
    signal?.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        signal?.removeEventListener("abort", stop);
        child.kill();
        reject(new Error(`Skill 执行超过 ${SKILL_EXECUTION_TIMEOUT_MS / 1000} 秒，已终止。`));
      }
    }, SKILL_EXECUTION_TIMEOUT_MS);
    child.once("error", (error) => {
      finished = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
      reject(new Error(`Skill 程序启动失败：${error.message}`));
    });
    child.once("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
      const secrets = Object.values(configured);
      const result = {
        exitCode: code ?? -1,
        stdout: redactSecrets(stdout.trim(), secrets),
        stderr: redactSecrets(stderr.trim(), secrets),
      };
      if (signal?.aborted) {
        reject(new Error("Skill 执行已取消。"));
      } else if (result.exitCode !== 0) {
        reject(new Error(
          `Skill 执行失败（退出码 ${result.exitCode}）：${result.stderr || result.stdout || "无输出"}`,
        ));
      } else {
        resolve(result);
      }
    });
  });
}

export function createSkillTools(): ToolDefinition[] {
  const listTool: ToolDefinition = {
    name: "skill_list",
    label: "查看已授权 Skill",
    description: "列出 Skill 设置中已启用且本次会话已授权的 Skill、用途、依赖程序及环境配置状态。",
    promptSnippet: "列出本次会话可使用的已启用 Skill 与配置状态。",
    parameters: Type.Object({}),
    async execute() {
      return toolResult(await Promise.all(discoverEnabledSkills().map(skillSummary)));
    },
  };

  const readTool: ToolDefinition = {
    name: "skill_read",
    label: "读取 Skill 指引",
    description: "读取已启用 Skill 的 SKILL.md 或其引用文件。relativePath 省略时读取 SKILL.md。",
    promptSnippet: "按名称读取已启用 Skill 的指引或引用文件，路径被限制在该 Skill 目录内。",
    parameters: Type.Object({
      skillName: Type.String({ description: "skill_list 返回的 Skill 名称" }),
      relativePath: Type.Optional(Type.String({ description: "Skill 内相对路径，默认 SKILL.md" })),
    }),
    async execute(_toolCallId, params) {
      const input = params as { skillName: string; relativePath?: string };
      const skill = findEnabledSkill(input.skillName);
      const relativePath = (input.relativePath || "SKILL.md").trim();
      if (!relativePath || path.isAbsolute(relativePath)) throw new Error("Skill 文件必须使用相对路径。");
      const baseDir = await realpath(skill.baseDir);
      const target = await realpath(path.resolve(baseDir, relativePath)).catch(() => "");
      if (!target || (target !== baseDir && !target.startsWith(`${baseDir}${path.sep}`))) {
        throw new Error("Skill 文件路径超出 Skill 目录。");
      }
      if (!READABLE_SKILL_EXTENSIONS.has(path.extname(target).toLowerCase())) {
        throw new Error("该 Skill 文件类型不允许读取。");
      }
      const metadata = await stat(target);
      if (!metadata.isFile()) throw new Error("Skill 读取目标不是普通文件。");
      if (metadata.size > MAX_SKILL_FILE_BYTES) {
        throw new Error(`Skill 文件过大（上限 ${MAX_SKILL_FILE_BYTES} 字节）。`);
      }
      return toolResult({
        skillName: skill.name,
        relativePath,
        content: await readFile(target, "utf8"),
      });
    },
  };

  const configureEnvironmentTool: ToolDefinition = {
    name: "skill_configure_environment",
    label: "配置 Skill 环境变量",
    description: "为已启用 Skill 保存其声明的环境变量。值会加密保存，工具结果和后续输出不会回显密钥。",
    promptSnippet: "安全保存 Skill 声明的 Token/API Key 等环境变量，不回显值。",
    executionMode: "sequential",
    parameters: Type.Object({
      skillName: Type.String({ description: "要配置的 Skill 名称" }),
      name: Type.String({ description: "Skill 声明的环境变量名" }),
      value: Type.String({ minLength: 1, description: "环境变量值；只用于加密保存，不会回显" }),
    }),
    async execute(_toolCallId, params) {
      const input = params as { skillName: string; name: string; value: string };
      const skill = findEnabledSkill(input.skillName);
      const requirements = await requirementsForSkill(skill);
      const name = input.name.trim();
      if (!requirements.env.includes(name)) {
        throw new Error(
          `Skill 未声明环境变量 ${name}；允许配置：${requirements.env.join("、") || "无"}`,
        );
      }
      await environmentStore().set(environmentAccount(skill.name, name), input.value);
      return toolResult({
        skillName: skill.name,
        name,
        configured: true,
        message: "环境变量已安全保存，值未回显。",
      });
    },
  };

  const executeTool: ToolDefinition = {
    name: "skill_execute",
    label: "执行 Skill",
    description: "执行已启用 Skill 自身 scripts 目录中的 Python/Node 脚本，或其 metadata 明确声明的程序。自动注入已保存环境变量。",
    promptSnippet: "受限执行已启用 Skill 声明的程序或自身脚本，并自动注入已配置环境。",
    parameters: Type.Object({
      skillName: Type.String({ description: "要执行的 Skill 名称" }),
      command: Type.String({ description: "metadata 声明的程序名，或 Skill 内 scripts/... 相对路径" }),
      arguments: Type.Optional(Type.Array(Type.String(), { maxItems: 64, description: "按原样传给程序的参数数组" })),
    }),
    async execute(_toolCallId, params, signal) {
      const input = params as { skillName: string; command: string; arguments?: string[] };
      const skill = findEnabledSkill(input.skillName);
      return toolResult(await runSkillProcess(skill, input.command, input.arguments ?? [], signal));
    },
  };

  return [listTool, readTool, configureEnvironmentTool, executeTool];
}

export function skillToolNames(): string[] {
  return ["skill_list", "skill_read", "skill_configure_environment", "skill_execute"];
}

export function skillAuthorizationPrompt(enabled: boolean): string {
  if (!enabled) return "";
  return "仅使用 skill_list 返回的已启用 Skill。先读取 SKILL.md 再执行；相对引用用 skill_read，脚本或声明程序用 skill_execute。" +
    " 用户提供 Skill Token/API Key 并要求配置时，必须调用 skill_configure_environment，禁止在回复或工具结果中回显密钥。";
}

export function formatSkillInventoryForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "【本次会话已启用 Skill】",
    "当请求与下列 Skill 匹配时，先调用 skill_read 读取完整 SKILL.md，再按其中规则工作。",
  ];
  for (const skill of skills) {
    lines.push(`- ${skill.name}：${skill.description}`);
  }
  return lines.join("\n");
}
