import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('defaults TypeSafe base URL / model to the SDK defaults when unset', () => {
    const c = loadConfig({ TYPESAFE_API_KEY: 'k' });
    assert.equal(c.typesafeApiKey, 'k');
    assert.equal(c.typesafeBaseUrl, '');
    assert.equal(c.typesafeModel, '');
    assert.equal(c.jevEnabled, true);
  });

  it('reads TYPESAFE_BASE_URL and TYPESAFE_MODEL', () => {
    const c = loadConfig({
      TYPESAFE_API_KEY: 'k',
      TYPESAFE_BASE_URL: 'https://proxy.example.com/v1',
      TYPESAFE_MODEL: 'jev-staging',
    });
    assert.equal(c.typesafeBaseUrl, 'https://proxy.example.com/v1');
    assert.equal(c.typesafeModel, 'jev-staging');
  });

  it('solver endpoint and model stay configurable; blank values fall back', () => {
    const c = loadConfig({ SOLVER_BASE_URL: 'https://api.deepseek.com', SOLVER_MODEL: 'deepseek-chat' });
    assert.equal(c.solverBaseUrl, 'https://api.deepseek.com');
    assert.equal(c.solverModel, 'deepseek-chat');
    const d = loadConfig({});
    assert.equal(d.solverBaseUrl, 'https://open.bigmodel.cn/api/paas/v4');
    assert.equal(d.solverModel, 'glm-4.5-flash');
    assert.equal(d.jevEnabled, false);
  });
});
