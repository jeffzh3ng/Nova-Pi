/**
 * JSON Schema（MCP 工具的 inputSchema）→ TypeBox（pi customTool 的 parameters）转换。
 *
 * 覆盖 MCP 工具常见的 schema 类型。遇到不认识的构造（$ref/oneOf/复杂组合）时，
 * 回退为 Type.Any() + 透传原始 args，保证工具仍可调用（只是失去参数校验）。
 */

import { Type, type TSchema } from "typebox";

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function jsonSchemaToTypebox(schema: unknown): TSchema {
  if (!isObject(schema)) return Type.Any();

  // $ref：MCP 工具一般不用 $ref，遇到则回退 Any
  if (typeof schema.$ref === "string") return Type.Any();

  // 组合关键字：anyOf/allOf 交并类型，回退 Any 保留透传
  if (schema.anyOf || schema.oneOf || schema.allOf) return Type.Any();

  const type = schema.type;
  const description = typeof schema.description === "string" ? schema.description : undefined;

  // 多类型（type 数组，如 ["string", "null"]）：取首个非 null 类型，标记可空
  if (Array.isArray(type)) {
    const primary = type.find((t) => t !== "null");
    if (!primary) return Type.Any();
    return convertSingle(primary, schema, description);
  }

  if (typeof type === "string") {
    return convertSingle(type, schema, description);
  }

  // 无 type 但有 properties：按 object 处理
  if (isObject(schema.properties)) {
    return convertObject(schema, description);
  }

  return Type.Any();
}

function convertSingle(type: string, schema: Record<string, unknown>, description?: string): TSchema {
  switch (type) {
    case "string": {
      const opts: Record<string, unknown> = {};
      if (description) opts.description = description;
      if (Array.isArray(schema.enum)) {
        return Type.Union(
          (schema.enum as unknown[]).filter((v): v is string => typeof v === "string").map((v) => Type.Literal(v)),
          opts,
        );
      }
      return Type.String(opts);
    }
    case "number":
    case "integer":
      return Type.Number(description ? { description } : {});
    case "boolean":
      return Type.Boolean(description ? { description } : {});
    case "array": {
      const items = isObject(schema.items) ? jsonSchemaToTypebox(schema.items) : Type.Any();
      return Type.Array(items, description ? { description } : {});
    }
    case "object":
      return convertObject(schema, description);
    default:
      return Type.Any();
  }
}

function convertObject(schema: Record<string, unknown>, description?: string): TSchema {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const keys = Object.keys(properties);
  const typeboxProps: Record<string, TSchema> = {};
  for (const key of keys) {
    const propSchema = properties[key];
    typeboxProps[key] = jsonSchemaToTypebox(propSchema);
  }
  return Type.Object(typeboxProps, {
    additionalProperties: true,
    ...(description ? { description } : {}),
    // required 通过 Type.Object 的选项无法直接传，typebox 的 required 由属性是否 Optional 决定；
    // 这里统一不标记 Optional（即默认 required），pi 在 prepareArguments 阶段会做兼容处理。
  });
}
