import type { AgentAdapter } from './types.ts';
import { ClaudeCodeAdapter } from './adapters/claude-code/index.ts';

/**
 * The adapters Pebble knows about.
 *
 * Adding a tool means adding a class here and nothing else — no view, route or
 * query mentions Claude Code by name.
 */
export function defaultAdapters(): AgentAdapter[] {
  return [new ClaudeCodeAdapter()];
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  constructor(adapters: AgentAdapter[] = defaultAdapters()) {
    for (const adapter of adapters) this.adapters.set(adapter.id, adapter);
  }

  all(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }
}
