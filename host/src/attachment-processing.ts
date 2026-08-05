/** @deprecated Compatibility entrypoint. Active sessions register only the document tool. */
import type { AgentAttachment } from "./attachments.js";
import { limitBlocks, parseStructuredDocument } from "./document/parsers.js";

export { DOCUMENT_TOOL_NAME as ATTACHMENT_TOOL_NAME, createDocumentExtension as createAttachmentExtension } from "./document/document-tool.js";

export async function inspectAttachment(file: AgentAttachment): Promise<{ text: string; parser: string }> {
  const parsed = await parseStructuredDocument(file, {});
  const limited = limitBlocks(parsed.blocks, 120_000);
  const format = file.ext.replace(/^\./, "").toLowerCase();
  return { text: limited.blocks.map((block) => block.text).join("\n\n"), parser: format === "txt" ? "text" : format };
}
