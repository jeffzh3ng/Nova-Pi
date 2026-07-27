const INTERNAL_ERROR_PATTERN =
  /cannot read (?:properties|property)|transformcallback|__tauri|\binvoke\b|\brpc\b|sidecar|unexpected token|json parse/i;

export const toUserFacingError = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim();

  if (!normalized || INTERNAL_ERROR_PATTERN.test(normalized)) {
    return fallback;
  }

  return normalized;
};
