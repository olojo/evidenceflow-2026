'use strict';

const express = require('express');
const { processEvidence } = require('./src/process-evidence');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.status(200).json({
    status: 'ok',
    service: 'evidenceflow',
  });
});

app.post('/', async (request, response) => {
  const eventId = request.get('ce-id');
  const eventType = request.get('ce-type');

  if (eventType !== 'google.cloud.storage.object.v1.finalized') {
    console.log(JSON.stringify({
      severity: 'NOTICE',
      message: 'Ignoring unsupported event',
      eventId,
      eventType,
    }));

    return response.status(204).send();
  }

  try {
    const result = await processEvidence({
      eventId,
      eventType,
      data: request.body,
    });

    console.log(JSON.stringify({
      severity: 'INFO',
      message: 'Evidence processed',
      ...result,
    }));

    return response.status(204).send();
  } catch (error) {
    console.error(JSON.stringify({
      severity: 'ERROR',
      message: 'Evidence processing failed',
      eventId,
      error: error.message,
    }));

    return response.status(500).json({
      error: 'Evidence processing failed',
    });
  }
});

const port = Number(process.env.PORT || 8080);

if (require.main === module) {
  app.listen(port, '0.0.0.0', () => {
    console.log(`EvidenceFlow listening on port ${port}`);
  });
}

module.exports = { app };
