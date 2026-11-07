export function errorBody(code: string, message: string, details?: unknown) {
  if (details === undefined) {
    return { error: { code, message } };
  }
  return { error: { code, message, details } };
}
