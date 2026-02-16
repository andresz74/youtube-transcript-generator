const test = require('node:test');
const assert = require('node:assert/strict');

const { createSmartSummaryV3Handler } = require('../lib/smart-summary-v3');

function createMockFirestore({ summaryDoc, transcriptDoc, onSummarySet }) {
  return {
    collection(name) {
      return {
        doc() {
          return {
            async get() {
              if (name === 'summaries') {
                return {
                  exists: Boolean(summaryDoc),
                  data: () => summaryDoc || {},
                };
              }
              return {
                exists: Boolean(transcriptDoc),
                data: () => transcriptDoc || {},
              };
            },
            async set(payload) {
              if (name === 'summaries' && onSummarySet) onSummarySet(payload);
            },
          };
        },
      };
    },
  };
}

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function createReq(body = {}) {
  return {
    body,
    headers: { 'x-request-id': 'test-request-1' },
    path: '/smart-summary-firebase-v3',
  };
}

function createAdminMock(firestoreDb) {
  function firestore() {
    return firestoreDb;
  }
  firestore.FieldValue = {
    serverTimestamp() {
      return 'timestamp';
    },
  };
  return { firestore };
}

const ytdl = {
  getURLVideoID(url) {
    if (!url.includes('youtube.com')) throw new Error('invalid');
    return 'video123';
  },
};

const logger = {
  info() {},
  error() {},
};

const modelUrls = {
  chatgpt: 'https://model.example/openai',
};

test('small transcript succeeds with direct strategy', async () => {
  const transcriptDoc = {
    title: 'Test video',
    transcript: 'Small transcript content.',
    description: 'Desc',
  };
  let persisted = null;
  const admin = createAdminMock(createMockFirestore({
    transcriptDoc,
    onSummarySet(payload) {
      persisted = payload;
    },
  }));

  const handler = createSmartSummaryV3Handler({
    admin,
    ytdl,
    modelUrls,
    postWithRetry: async () => ({ data: { summaryText: 'Direct summary text', tags: ['tag1'] } }),
    buildTagsFromText: () => ['fallback'],
    logger,
    summaryDebug: false,
  });

  const req = createReq({ url: 'https://www.youtube.com/watch?v=abc', model: 'chatgpt' });
  const res = createRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.fromCache, false);
  assert.equal(res.body.mode, 'direct');
  assert.ok(typeof res.body.summary === 'string');
  assert.ok(persisted && typeof persisted.summary === 'string');
});

test('oversized transcript returns controlled 413 JSON', async () => {
  const oldMax = process.env.SMART_SUMMARY_MAX_TRANSCRIPT_CHARS;
  process.env.SMART_SUMMARY_MAX_TRANSCRIPT_CHARS = '50';

  const transcriptDoc = {
    title: 'Big video',
    transcript: 'x'.repeat(120),
    description: 'desc',
  };
  const admin = createAdminMock(createMockFirestore({ transcriptDoc }));
  const handler = createSmartSummaryV3Handler({
    admin,
    ytdl,
    modelUrls,
    postWithRetry: async () => ({ data: { summaryText: 'unused' } }),
    buildTagsFromText: () => ['fallback'],
    logger,
    summaryDebug: false,
  });
  const req = createReq({ url: 'https://www.youtube.com/watch?v=abc', model: 'chatgpt' });
  const res = createRes();
  await handler(req, res);

  assert.equal(res.statusCode, 413);
  assert.equal(res.body.code, 'TRANSCRIPT_TOO_LARGE');
  assert.equal(typeof res.body.message, 'string');
  assert.ok(!String(res.body.message).includes('<html'));

  if (oldMax === undefined) delete process.env.SMART_SUMMARY_MAX_TRANSCRIPT_CHARS;
  else process.env.SMART_SUMMARY_MAX_TRANSCRIPT_CHARS = oldMax;
});

test('large but valid transcript succeeds via chunking', async () => {
  const prevDirect = process.env.SMART_SUMMARY_DIRECT_MAX_CHARS;
  const prevTarget = process.env.SMART_SUMMARY_CHUNK_TARGET_CHARS;
  process.env.SMART_SUMMARY_DIRECT_MAX_CHARS = '100';
  process.env.SMART_SUMMARY_CHUNK_TARGET_CHARS = '120';

  const transcriptDoc = {
    title: 'Chunked video',
    transcript: 'Paragraph one grows.\n\nParagraph two grows too.\n\nParagraph three keeps going.'.repeat(8),
    description: 'desc',
  };
  const calls = [];
  const admin = createAdminMock(createMockFirestore({ transcriptDoc }));
  const handler = createSmartSummaryV3Handler({
    admin,
    ytdl,
    modelUrls,
    postWithRetry: async (_url, payload) => {
      calls.push(payload);
      if (payload.transcript && payload.transcript.includes('Chunk 1:')) {
        return { data: { summaryText: 'Final summary', tags: ['one', 'two'] } };
      }
      return { data: { summaryText: 'Chunk summary line' } };
    },
    buildTagsFromText: () => ['fallback'],
    logger,
    summaryDebug: false,
  });

  const req = createReq({ url: 'https://www.youtube.com/watch?v=abc', model: 'chatgpt' });
  const res = createRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, 'chunked');
  assert.ok(Number(res.body.chunkCount) > 1);
  assert.ok(calls.length >= 3);
  assert.ok(!String(res.body.summary).includes('<html'));

  if (prevDirect === undefined) delete process.env.SMART_SUMMARY_DIRECT_MAX_CHARS;
  else process.env.SMART_SUMMARY_DIRECT_MAX_CHARS = prevDirect;
  if (prevTarget === undefined) delete process.env.SMART_SUMMARY_CHUNK_TARGET_CHARS;
  else process.env.SMART_SUMMARY_CHUNK_TARGET_CHARS = prevTarget;
});

test('async submit returns queued and status endpoint returns succeeded', async () => {
  const transcriptDoc = {
    title: 'Async video',
    transcript: 'Small transcript content for async flow.',
    description: 'desc',
  };
  const admin = createAdminMock(createMockFirestore({ transcriptDoc }));
  const handler = createSmartSummaryV3Handler({
    admin,
    ytdl,
    modelUrls,
    postWithRetry: async () => ({ data: { summaryText: 'Async summary text', tags: ['tag1'] } }),
    buildTagsFromText: () => ['fallback'],
    logger,
    summaryDebug: false,
  });

  const req = createReq({ url: 'https://www.youtube.com/watch?v=abc', model: 'chatgpt' });
  req.params = {};
  const res = createRes();
  await handler.submitAsyncHandler(req, res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, 'queued');
  assert.ok(res.body.requestId);

  await new Promise((resolve) => setTimeout(resolve, 25));
  const statusReq = { params: { requestId: res.body.requestId } };
  const statusRes = createRes();
  await handler.getStatusHandler(statusReq, statusRes);

  assert.equal(statusRes.statusCode, 200);
  assert.equal(statusRes.body.status, 'succeeded');
  assert.ok(statusRes.body.result);
  assert.equal(statusRes.body.result.fromCache, false);
});
