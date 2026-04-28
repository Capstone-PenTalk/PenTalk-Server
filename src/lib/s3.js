const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { logger } = require('../utils/logger');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.S3_BUCKET_NAME;

async function uploadBuffer(key, buffer, contentType) {
  try {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  } catch (err) {
    logger.error('[S3] uploadBuffer failed', { key, name: err.name, message: err.message, statusCode: err.$metadata?.httpStatusCode });
    throw new Error('S3 upload failed');
  }
}

async function uploadString(key, content) {
  try {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: content, ContentType: 'application/json' }));
  } catch (err) {
    logger.error('[S3] uploadString failed', { key, name: err.name, message: err.message, statusCode: err.$metadata?.httpStatusCode });
    throw new Error('S3 upload failed');
  }
}

async function downloadString(key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    logger.error('[S3] downloadString failed', { key, name: err.name, message: err.message, statusCode: err.$metadata?.httpStatusCode });
    throw new Error('S3 download failed');
  }
}

async function getPresignedUrl(key, expiresIn = 3600) {
  try {
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
  } catch (err) {
    logger.error('[S3] getPresignedUrl failed', { key, name: err.name, message: err.message, statusCode: err.$metadata?.httpStatusCode });
    throw new Error('S3 presigned URL failed');
  }
}

module.exports = { uploadBuffer, uploadString, downloadString, getPresignedUrl };
