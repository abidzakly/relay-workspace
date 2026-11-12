import { MockAgent } from 'undici';
import { HttpClient, type HttpClientOptions } from '../services/httpClient';
import { createLogger } from '../util/logger';

/** An `HttpClient` wired to an undici `MockAgent` (no real network, no real sleeping). */
export function mockHttp(over: Partial<HttpClientOptions> = {}) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const log = createLogger({
    level: 'trace',
    destination: { write: (s: string) => void logs.push(s) },
  });
  const http = new HttpClient({
    log,
    dispatcher: agent,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...over,
  });
  let closed = false;
  return {
    agent,
    http,
    logs,
    sleeps,
    log,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return agent.close();
    },
  };
}

export const JSON_HEADERS = { 'content-type': 'application/json' };
