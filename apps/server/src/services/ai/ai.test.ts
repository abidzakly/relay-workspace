import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { parseClaudeEnvelope } from '../cockpit/claudeCli';
import { memDb, silentLog } from '../../testing/memDb';
import { AiService } from './aiService';
import { AiError, extractJson, type AiCompleteRequest, type AiProvider } from './provider';
import { renderTemplate } from './templates';

describe('claude CLI envelope', () => {
  it('returns the result text', () => {
    expect(parseClaudeEnvelope('{"type":"result","is_error":false,"result":"hi"}')).toBe('hi');
  });
  it('refuses errors and non-JSON', () => {
    expect(() => parseClaudeEnvelope('{"is_error":true,"subtype":"error_max_turns"}')).toThrow();
    expect(() => parseClaudeEnvelope('nope')).toThrow();
  });
});

describe('extractJson', () => {
  it('reads fenced and bare JSON', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('ok {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
  });
  it('throws ai_bad_output without JSON', () => {
    expect(() => extractJson('no json')).toThrow(AiError);
  });
});

describe('renderTemplate', () => {
  it('fills placeholders without re-expanding values', () => {
    const p = renderTemplate('turn-summary', { diff: 'x {{diff}} y' });
    expect(p).toContain('x {{diff}} y');
    expect(p.replace('x {{diff}} y', '')).not.toMatch(/\{\{[a-z]+\}\}/);
  });
});

class FakeProvider implements AiProvider {
  readonly engine = 'claude_cli' as const;
  calls = 0;
  constructor(private readonly answer: unknown) {}
  complete<S extends z.ZodType>(req: AiCompleteRequest<S>): Promise<z.infer<S>> {
    this.calls++;
    return Promise.resolve(req.schema.parse(this.answer));
  }
}

describe('AiService', () => {
  it('caches by prompt content', async () => {
    const p = new FakeProvider({ headline: 'Agent mengubah 1 file', files: ['a.dart'] });
    const ai = new AiService({ store: memDb(), log: silentLog, host: null, providers: [p] });
    const a = await ai.run('turn-summary', { diff: 'd1' });
    const b = await ai.run('turn-summary', { diff: 'd1' });
    const c = await ai.run('turn-summary', { diff: 'd2' });
    expect([a.cached, b.cached, c.cached]).toEqual([false, true, false]);
    expect(p.calls).toBe(2);
  });
  it('rejects an out-of-range teach-back score', async () => {
    const p = new FakeProvider({ score: 7, missed: '', correction: '' });
    const ai = new AiService({ store: memDb(), log: silentLog, host: null, providers: [p] });
    await expect(ai.run('grade-teachback', {})).rejects.toThrow('score must be 0–3');
  });
  it('reports no engine', async () => {
    const ai = new AiService({ store: memDb(), log: silentLog, host: null });
    expect((await ai.status()).engine).toBe('none');
    await expect(ai.run('triage', {})).rejects.toMatchObject({ code: 'ai_unavailable' });
  });
});
