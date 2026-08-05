export type DocumentStage = "structure" | "ocr" | "vision";
export type DocumentStatus = "complete" | "partial" | "needs_ocr" | "needs_vision" | "unsupported" | "rejected";

export type DocumentBlock = {
  type: "text" | "sheet" | "slide" | "page";
  index?: number;
  name?: string;
  text: string;
};

export type DocumentMetadata = {
  bytes: number;
  pages?: number;
  sheets?: number;
  slides?: number;
  zipEntries?: number;
};

export type DocumentResult = {
  ok: boolean;
  attachmentId?: string;
  name?: string;
  format?: string;
  stage: DocumentStage;
  status: DocumentStatus;
  document?: DocumentMetadata;
  blocks: DocumentBlock[];
  truncated: boolean;
  warnings: string[];
  next: string;
};

export type DocumentReadOptions = {
  pages?: number[];
  sheetNames?: string[];
  slideNumbers?: number[];
  maxChars?: number;
  includeNotes?: boolean;
  includeFormulas?: boolean;
  signal?: AbortSignal;
  bytes?: Buffer;
};
