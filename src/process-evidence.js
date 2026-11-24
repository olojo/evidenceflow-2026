'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { Storage } = require('@google-cloud/storage');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const storage = new Storage();
const firestore = new Firestore();

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

const ALLOWED_TYPES = new Map([
  ['application/pdf', ['.pdf']],
  ['image/png', ['.png']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['text/plain', ['.txt']],
]);

function requireEnvironmentVariable(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function fileSignatureMatches(contentType, buffer) {
  if (!buffer || buffer.length === 0) {
    return false;
  }

  if (contentType === 'application/pdf') {
    return buffer.subarray(0, 5).toString() === '%PDF-';
  }

  if (contentType === 'image/png') {
    const pngSignature = Buffer.from([
      0x89, 0x50, 0x4e, 0x47,
      0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    return buffer.subarray(0, 8).equals(pngSignature);
  }

  if (contentType === 'image/jpeg') {
    return (
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }

  if (contentType === 'text/plain') {
    return !buffer.includes(0);
  }

  return false;
}

function createEvidenceId(bucket, objectName, generation) {
  return crypto
    .createHash('sha256')
    .update(`${bucket}\n${objectName}\n${generation}`)
    .digest('hex');
}

function createDestinationName(evidenceId, originalName) {
  const baseName = path.posix.basename(originalName);

  const safeName = baseName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 180) || 'evidence';

  return `${evidenceId}/${safeName}`;
}

async function copyOnlyOnce(sourceFile, destinationFile) {
  try {
    await sourceFile.copy(destinationFile, {
      preconditionOpts: {
        ifGenerationMatch: 0,
      },
    });

    return 'created';
  } catch (error) {
    if (Number(error.code) === 412) {
      return 'already-exists';
    }

    throw error;
  }
}

async function processEvidence({ eventId, data }) {
  const intakeBucket = requireEnvironmentVariable('INTAKE_BUCKET');
  const processedBucket = requireEnvironmentVariable('PROCESSED_BUCKET');
  const quarantineBucket = requireEnvironmentVariable('QUARANTINE_BUCKET');

  const maxFileBytes = Number(
    process.env.MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES
  );

  if (!data?.bucket || !data?.name) {
    throw new Error('Storage event is missing its bucket or object name');
  }

  if (data.bucket !== intakeBucket) {
    return {
      status: 'ignored',
      reason: 'unexpected-source-bucket',
      sourceBucket: data.bucket,
      sourceObject: data.name,
    };
  }

  const sourceBucket = data.bucket;
  const sourceObject = data.name;
  const sourceGeneration = String(data.generation ?? '');

  const evidenceId = createEvidenceId(
    sourceBucket,
    sourceObject,
    sourceGeneration
  );

  const document = firestore.collection('evidence').doc(evidenceId);
  const previousRecord = await document.get();

  if (previousRecord.exists) {
    const previousStatus = previousRecord.get('status');

    if (
      previousStatus === 'processed' ||
      previousStatus === 'quarantined'
    ) {
      return {
        evidenceId,
        status: previousStatus,
        duplicateEvent: true,
      };
    }
  }

  const sourceOptions = sourceGeneration
    ? { generation: Number(sourceGeneration) }
    : {};

  const sourceFile = storage
    .bucket(sourceBucket)
    .file(sourceObject, sourceOptions);

  const [metadata] = await sourceFile.getMetadata();

  const sizeBytes = Number(metadata.size || data.size || 0);

  const contentType = String(
    metadata.contentType || data.contentType || ''
  )
    .split(';')[0]
    .trim()
    .toLowerCase();

  const extension = path.posix.extname(sourceObject).toLowerCase();
  const validationMessages = [];

  const allowedExtensions = ALLOWED_TYPES.get(contentType);

  if (!allowedExtensions) {
    validationMessages.push(
      `Unsupported content type: ${contentType || 'unknown'}`
    );
  } else if (!allowedExtensions.includes(extension)) {
    validationMessages.push(
      `Extension ${extension || 'missing'} does not match ${contentType}`
    );
  }

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    validationMessages.push('File is empty or has an invalid size');
  }

  if (sizeBytes > maxFileBytes) {
    validationMessages.push(
      `File exceeds the ${maxFileBytes}-byte size limit`
    );
  }

  await document.set({
    evidenceId,
    eventId: eventId || null,
    status: 'processing',
    sourceBucket,
    sourceObject,
    sourceGeneration: sourceGeneration || null,
    contentType: contentType || null,
    sizeBytes,
    receivedAt: data.timeCreated || metadata.timeCreated || null,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  let checksumSha256 = null;

  if (sizeBytes > 0 && sizeBytes <= maxFileBytes) {
    const [buffer] = await sourceFile.download();

    checksumSha256 = crypto
      .createHash('sha256')
      .update(buffer)
      .digest('hex');

    if (
      allowedExtensions &&
      !fileSignatureMatches(contentType, buffer)
    ) {
      validationMessages.push(
        'The file contents do not match the declared file type'
      );
    }
  }

  const status = validationMessages.length === 0
    ? 'processed'
    : 'quarantined';

  const destinationBucket = status === 'processed'
    ? processedBucket
    : quarantineBucket;

  const destinationObject = createDestinationName(
    evidenceId,
    sourceObject
  );

  const destinationFile = storage
    .bucket(destinationBucket)
    .file(destinationObject);

  const copyResult = await copyOnlyOnce(
    sourceFile,
    destinationFile
  );

  await document.set({
    status,
    destinationBucket,
    destinationObject,
    checksumAlgorithm: checksumSha256 ? 'SHA-256' : null,
    checksumSha256,
    checksumStatus: checksumSha256
      ? 'calculated'
      : 'skipped-size-limit',
    validationMessages: validationMessages.length
      ? validationMessages
      : ['Validation passed'],
    copyResult,
    processedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    evidenceId,
    status,
    sourceObject,
    destinationBucket,
    destinationObject,
    checksumSha256,
  };
}

module.exports = {
  processEvidence,
};
