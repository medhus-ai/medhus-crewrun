export function emitLines(onLine, text) {
  for (const line of String(text).split("\n")) {
    onLine?.(line);
  }
}
