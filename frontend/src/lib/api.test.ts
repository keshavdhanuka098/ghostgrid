import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, pick, request } from './api';
import { integrationsApi } from './integrations';

const reply = (body: string | null, init: ResponseInit = { status: 200 }) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, init)));
afterEach(() => vi.unstubAllGlobals());

describe('request()', () => {
  it('returns parsed JSON for a good reply', async () => {
    reply('{"ok":true}');
    expect(await request('GET', '/api/health')).toEqual({ ok: true });
  });

  it('treats a 200 that is not JSON (e.g. index.html from a static host) as an error, not as data', async () => {
    reply('<!doctype html><html></html>');
    await expect(request('GET', '/api/scenarios')).rejects.toBeInstanceOf(ApiError);
    await expect(request('GET', '/api/scenarios')).rejects.toThrow(/could not read/i);
  });

  it('passes the server message and status through on an error reply', async () => {
    reply('{"error":"Scenario not found."}', { status: 404 });
    await expect(request('GET', '/api/scenarios/x')).rejects.toMatchObject({ message: 'Scenario not found.', status: 404 });
  });

  it('survives an error reply with a non-JSON or oddly-shaped body', async () => {
    reply('Bad gateway', { status: 502 });
    await expect(request('GET', '/x')).rejects.toMatchObject({ status: 502, message: 'The server responded with 502.' });
    reply('{"error":42,"details":"nope"}', { status: 400 });
    await expect(request('GET', '/x')).rejects.toMatchObject({ status: 400, message: 'The server responded with 400.', details: [] });
  });

  it('keeps 204 as an empty success', async () => {
    reply(null, { status: 204 });
    expect(await request('DELETE', '/x')).toBeUndefined();
  });

  it('reports an unreachable server in plain words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(request('GET', '/x')).rejects.toThrow(/cannot reach the ghostgrid server/i);
  });
});

describe('pick()', () => {
  it('returns the field when it has the right shape', () => {
    expect(pick<number[]>({ a: [1] }, 'a', 'array')).toEqual([1]);
    expect(pick<{ x: 1 }>({ a: { x: 1 } }, 'a')).toEqual({ x: 1 });
  });
  it.each([[null], [undefined], [{}], [{ a: 'str' }], [{ a: null }], [[]], ['text']])('rejects a missing or wrong-shaped field (%j)', (bad) => {
    expect(() => pick(bad, 'a', 'array')).toThrow(ApiError);
    expect(() => pick(bad, 'a')).toThrow(ApiError);
  });
});

describe('API clients never hand the UI undefined', () => {
  it('scenarios list with the wrong shape is an error, not undefined', async () => {
    reply('{"nope":1}');
    await expect(api.list()).rejects.toBeInstanceOf(ApiError);
  });
  it('integrations list and health check with the wrong shape are errors', async () => {
    reply('{"scenarios":[]}');
    await expect(integrationsApi.list()).rejects.toBeInstanceOf(ApiError);
    await expect(integrationsApi.check()).rejects.toBeInstanceOf(ApiError);
    await expect(integrationsApi.imports()).rejects.toBeInstanceOf(ApiError);
  });
  it('feature extraction with the wrong shape is an error', async () => {
    reply('{"graph":{}}');
    await expect(api.extractFeatures('s')).rejects.toBeInstanceOf(ApiError);
  });
});
