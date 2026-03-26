const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const zlib = require('zlib');
const { promisify } = require('util');
const { config } = require('./config');

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

let s3Client;

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: config.s3.region
    });
  }
  return s3Client;
}

function ensureBucketConfigured() {
  if (!config.s3.bucket) {
    throw new Error('S3 bucket is not configured. Set S3_BUCKET_NAME in .env');
  }
}

function buildGameStateKey(gameType, matchId, version = 'final') {
  const safeGameType = (gameType || 'ludo').toString().trim().toLowerCase();
  const safeMatchId = String(matchId || '').trim();
  const safeVersion = String(version || 'final').trim();
  const prefix = config.s3.prefix.replace(/\/+$/, '');
  return `${prefix}/${safeGameType}/${safeMatchId}/state-${safeVersion}.json.gz`;
}

async function uploadGameStateJson({
  key,
  payload,
  contentType = 'application/json',
  compress = true,
  metadata = {}
}) {
  ensureBucketConfigured();
  if (!key) throw new Error('S3 key is required');
  if (payload === undefined || payload === null) throw new Error('S3 payload is required');

  const s3 = getS3Client();
  const rawBody = Buffer.from(JSON.stringify(payload));
  const body = compress ? await gzipAsync(rawBody) : rawBody;

  const params = {
    Bucket: config.s3.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ACL: config.s3.acl,
    Metadata: Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [String(k), String(v)])
    )
  };

  if (compress) {
    params.ContentEncoding = 'gzip';
  }

  if (config.s3.serverSideEncryption) {
    params.ServerSideEncryption = config.s3.serverSideEncryption;
  }

  const result = await s3.send(new PutObjectCommand(params));
  return {
    bucket: config.s3.bucket,
    key,
    etag: result.ETag || '',
    contentEncoding: params.ContentEncoding || ''
  };
}

async function getGameStateJson(key) {
  ensureBucketConfigured();
  if (!key) throw new Error('S3 key is required');

  const s3 = getS3Client();
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    })
  );

  const bodyBuffer = Buffer.from(await result.Body.transformToByteArray());
  const decoded = result.ContentEncoding === 'gzip' ? await gunzipAsync(bodyBuffer) : bodyBuffer;
  return JSON.parse(decoded.toString('utf8'));
}

module.exports = {
  getS3Client,
  buildGameStateKey,
  uploadGameStateJson,
  getGameStateJson
};
