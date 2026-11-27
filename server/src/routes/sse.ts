export interface SseEvent {
  event: string;
  data: string;
}

export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSseParser(
  onEvent: (event: SseEvent) => void,
): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = raw.split("\n");
      const event =
        lines.find((l) => l.startsWith("event: "))?.slice("event: ".length) ??
        "message";
      const data = lines
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice("data: ".length))
        .join("\n");
      onEvent({ event, data });
      boundary = buffer.indexOf("\n\n");
    }
  };
}
