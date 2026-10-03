/**
 * A tiny broadcast bus so the server can push index changes to open dashboards
 * over SSE without every tab polling the API.
 */
export type PebbleEvent =
  | { type: 'index'; updated: number; durationMs: number; at: string }
  | { type: 'hello'; at: string }
  | { type: 'ping'; at: string };

type Listener = (event: PebbleEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: PebbleEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not take down the indexer.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
