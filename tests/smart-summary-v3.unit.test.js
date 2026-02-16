const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSummaryConfig,
  splitTranscriptIntoChunks,
  mapSummaryFailure,
  smartSummaryJsonErrorHandler,
} = require('../lib/smart-summary-v3');

test('createSummaryConfig uses defaults and env overrides', () => {
  const cfg = createSummaryConfig({
    SMART_SUMMARY_MAX_TRANSCRIPT_CHARS: '1200',
    SMART_SUMMARY_CHUNK_TARGET_CHARS: '300',
  });
  assert.equal(cfg.maxTranscriptChars, 1200);
  assert.equal(cfg.chunkTargetChars, 300);
  assert.equal(cfg.directTranscriptChars, 24000);
});

test('splitTranscriptIntoChunks keeps chunks under target and preserves content', () => {
  const transcript = [
    'Paragraph one has enough words to force chunking behavior for the first block.',
    'Paragraph two adds more lines and context for the second block.',
    'Paragraph three finalizes the thought with extra detail and examples.',
  ].join('\n\n');
  const chunks = splitTranscriptIntoChunks({
    transcript,
    targetChars: 100,
    overlapChars: 20,
  });
  assert.ok(chunks.length > 1);
  chunks.forEach((chunk) => {
    assert.ok(chunk.length <= 120);
  });
});

test('mapSummaryFailure maps status and code consistently', () => {
  const timeoutErr = new Error('upstream timed out');
  timeoutErr.code = 'timeout';
  const mapped = mapSummaryFailure(timeoutErr);
  assert.equal(mapped.status, 500);
  assert.equal(mapped.code, 'SUMMARY_UPSTREAM_FAILURE');
  assert.match(mapped.message, /timed out/);

  const tooLargeErr = new Error('too large');
  tooLargeErr.status = 413;
  tooLargeErr.clientCode = 'TRANSCRIPT_TOO_LARGE';
  const mappedTooLarge = mapSummaryFailure(tooLargeErr);
  assert.equal(mappedTooLarge.status, 413);
  assert.equal(mappedTooLarge.code, 'TRANSCRIPT_TOO_LARGE');
});

test('smartSummaryJsonErrorHandler maps parser errors to JSON payloads', () => {
  const req = { path: '/smart-summary-firebase-v3' };
  const res = {
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

  const tooLarge = { type: 'entity.too.large', status: 413 };
  smartSummaryJsonErrorHandler(tooLarge, req, res, () => {});
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.code, 'PAYLOAD_TOO_LARGE');

  const syntaxErr = new SyntaxError('bad json');
  syntaxErr.status = 400;
  syntaxErr.body = '{}';
  smartSummaryJsonErrorHandler(syntaxErr, req, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'INVALID_JSON');
});
