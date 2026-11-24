'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { app } = require('../index');

async function withServer(run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('GET /health reports a healthy service', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      status: 'ok',
      service: 'evidenceflow',
    });
  });
});

test('POST / ignores unsupported event types', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'ce-id': 'automated-test-1',
        'ce-type': 'example.unsupported',
      },
      body: '{}',
    });

    assert.equal(response.status, 204);
  });
});
