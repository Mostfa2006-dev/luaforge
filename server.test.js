const { describe, it } = require('node:test');
const assert = require('node:assert');

// Unit test: sparse embedding fallback produces correct shape
describe('sparse embedding fallback', () => {
  const dim = 768;
  function sparseEmbed(text) {
    const vec = new Array(dim).fill(0);
    const tokens = text.toLowerCase().slice(0, 2000).split(/\W+/).filter(Boolean);
    for (const tok of tokens) {
      let h = 5381;
      for (let i = 0; i < tok.length; i++) h = ((h << 5) + h) ^ tok.charCodeAt(i);
      vec[Math.abs(h) % dim] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / norm);
  }

  it('returns 768-dim normalized vector', () => {
    const v = sparseEmbed('local Players = game:GetService("Players")');
    assert.strictEqual(v.length, dim);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-6, 'vector should be unit-normalized');
  });

  it('produces different vectors for different inputs', () => {
    const v1 = sparseEmbed('function onPlayerJoined(player) end');
    const v2 = sparseEmbed('local RunService = game:GetService("RunService")');
    const dot = v1.reduce((s, x, i) => s + x * v2[i], 0);
    assert.ok(dot < 0.99, 'different inputs should not be identical');
  });
});

// Unit test: circuit breaker logic
describe('circuit breaker', () => {
  const CB_THRESHOLD = 3, CB_COOLDOWN = 30000;
  const breakers = new Map();
  function isOpen(url) {
    const b = breakers.get(url);
    if (!b) return false;
    if (Date.now() > b.openUntil) { breakers.delete(url); return false; }
    return true;
  }
  function recordFailure(url) {
    const b = breakers.get(url) || { failures: 0, openUntil: 0 };
    b.failures++;
    if (b.failures >= CB_THRESHOLD) b.openUntil = Date.now() + CB_COOLDOWN;
    breakers.set(url, b);
  }

  it('opens after threshold failures', () => {
    const url = 'https://api.test.com';
    for (let i = 0; i < CB_THRESHOLD; i++) recordFailure(url);
    assert.ok(isOpen(url), 'circuit should be open after 3 failures');
  });

  it('stays closed before threshold', () => {
    const url = 'https://api.test2.com';
    for (let i = 0; i < CB_THRESHOLD - 1; i++) recordFailure(url);
    assert.ok(!isOpen(url), 'circuit should stay closed before threshold');
  });
});
