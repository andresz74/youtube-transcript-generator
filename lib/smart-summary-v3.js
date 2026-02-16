const DEFAULT_RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const DIRECT_SUMMARY_PROMPT =
  'Summarize this transcript in clear Markdown with key points and takeaways.';
const ASYNC_JOB_TTL_MS = 10 * 60 * 1000;
const ASYNC_JOB_MAX_ENTRIES = 1000;

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function createSummaryConfig(env) {
  return {
    maxTranscriptChars: toPositiveInt(env.SMART_SUMMARY_MAX_TRANSCRIPT_CHARS, 300000),
    directTranscriptChars: toPositiveInt(env.SMART_SUMMARY_DIRECT_MAX_CHARS, 24000),
    chunkTargetChars: toPositiveInt(env.SMART_SUMMARY_CHUNK_TARGET_CHARS, 8000),
    chunkOverlapChars: toPositiveInt(env.SMART_SUMMARY_CHUNK_OVERLAP_CHARS, 200),
    maxChunks: toPositiveInt(env.SMART_SUMMARY_MAX_CHUNKS, 32),
    stageTimeoutMs: toPositiveInt(env.SMART_SUMMARY_STAGE_TIMEOUT_MS, 25000),
    stageRetries: toPositiveInt(env.SMART_SUMMARY_STAGE_RETRIES, 1),
  };
}

function splitTranscriptIntoChunks({ transcript, targetChars, overlapChars }) {
  const normalized = String(transcript || '').trim();
  if (!normalized) return [];
  if (normalized.length <= targetChars) return [normalized];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  const pushChunk = () => {
    if (!current.trim()) return;
    chunks.push(current.trim());
    const overlap = overlapChars > 0 ? current.slice(-overlapChars).trim() : '';
    current = overlap;
  };

  const units = paragraphs.length > 0 ? paragraphs : [normalized];

  const splitOversizedUnit = (text) => {
    const slices = [];
    const safeTarget = Math.max(200, targetChars);
    const safeOverlap = Math.max(0, Math.min(overlapChars, safeTarget - 50));
    let start = 0;
    while (start < text.length) {
      const end = Math.min(text.length, start + safeTarget);
      const slice = text.slice(start, end).trim();
      if (slice) slices.push(slice);
      if (end >= text.length) break;
      start = Math.max(0, end - safeOverlap);
    }
    return slices;
  };

  units.forEach((unit) => {
    if (unit.length > targetChars) {
      pushChunk();
      splitOversizedUnit(unit).forEach((part) => {
        chunks.push(part);
      });
      current = '';
      return;
    }

    if (!current) {
      current = unit;
      return;
    }

    const candidate = `${current}\n\n${unit}`;
    if (candidate.length <= targetChars) {
      current = candidate;
      return;
    }

    if (current.length >= targetChars) {
      pushChunk();
      current = unit;
      return;
    }

    pushChunk();
    current = unit;
  });

  pushChunk();
  return chunks;
}

function parseModelSummary(data, model) {
  if (!data || typeof data !== 'object') return '';
  if (model === 'anthropic') {
    return data.content?.[0]?.text || '';
  }
  return data.summaryText
    || data.text
    || data.summary?.choices?.[0]?.message?.content
    || data.choices?.[0]?.message?.content
    || '';
}

function parseTags(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (_) {
    return value
      .split('\n')
      .map((tag) => tag.replace(/^-\s*/, '').trim())
      .filter(Boolean);
  }
}

function shouldRetryError(error) {
  if (!error) return false;
  if (error.code === 'timeout') return true;
  const status = Number(error?.response?.status || error?.status || 0);
  return DEFAULT_RETRYABLE_STATUS_CODES.has(status);
}

function isUpstreamTranscriptNotFound(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  const upstreamMessage = String(
    error?.response?.data?.error || error?.response?.data?.message || error?.message || '',
  ).toLowerCase();
  return status === 404 && upstreamMessage.includes('transcript not found');
}

function resolveFallbackModelUrl(modelUrl, model) {
  if (!modelUrl || typeof modelUrl !== 'string') return null;
  let fallbackPath = '';
  if (model === 'chatgpt') fallbackPath = '/api/openai-chat-axios';
  if (model === 'deepseek') fallbackPath = '/api/deepseek-chat-axios';
  if (model === 'anthropic') fallbackPath = '/api/anthropic-chat';
  if (!fallbackPath) return null;

  try {
    const url = new URL(modelUrl);
    url.pathname = fallbackPath;
    return url.toString();
  } catch (_) {
    return null;
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.code = 'timeout';
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function mapSummaryFailure(error) {
  const status = Number(error?.status || error?.response?.status || 500);
  const mappedStatus = status >= 400 && status < 600 ? status : 500;
  const code = error?.clientCode
    || (mappedStatus === 413 ? 'TRANSCRIPT_TOO_LARGE' : 'SUMMARY_UPSTREAM_FAILURE');
  const message = error?.clientMessage
    || error?.response?.data?.message
    || error?.response?.data?.error
    || error?.message
    || 'Summary generation failed.';
  return { status: mappedStatus, code, message };
}

function createMetrics() {
  const counters = {
    total: 0,
    success: 0,
    errors5xx: 0,
    timeouts: 0,
    payloadTooLargeRejects: 0,
  };
  const durationsMs = [];

  return {
    inc(name, by = 1) {
      counters[name] = (counters[name] || 0) + by;
    },
    observeDuration(ms) {
      durationsMs.push(ms);
      if (durationsMs.length > 500) durationsMs.shift();
    },
    snapshot() {
      const sorted = durationsMs.slice().sort((a, b) => a - b);
      const p95 = sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
        : 0;
      return { counters: { ...counters }, p95LatencyMs: p95 };
    },
  };
}

function getRequestId(req) {
  return req.headers['x-request-id']
    || req.headers['cf-ray']
    || req.headers['x-vercel-id']
    || `req-${Date.now()}`;
}

function createAsyncJobStore() {
  const jobs = new Map();

  const prune = () => {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
      if (now - job.updatedAt > ASYNC_JOB_TTL_MS) jobs.delete(id);
    }
    while (jobs.size > ASYNC_JOB_MAX_ENTRIES) {
      const firstKey = jobs.keys().next().value;
      jobs.delete(firstKey);
    }
  };

  return {
    create(id) {
      prune();
      const now = Date.now();
      const job = {
        requestId: id,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      };
      jobs.set(id, job);
      return job;
    },
    start(id) {
      const job = jobs.get(id);
      if (!job) return;
      job.status = 'processing';
      job.updatedAt = Date.now();
    },
    succeed(id, result) {
      const job = jobs.get(id);
      if (!job) return;
      job.status = 'succeeded';
      job.result = result;
      job.updatedAt = Date.now();
    },
    fail(id, errorPayload) {
      const job = jobs.get(id);
      if (!job) return;
      job.status = 'failed';
      job.error = errorPayload;
      job.updatedAt = Date.now();
    },
    get(id) {
      prune();
      return jobs.get(id) || null;
    },
  };
}

function safeString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function buildSummaryFrontmatter({ metadata, tags, videoID }) {
  const rawDescription = safeString(metadata.description);
  const yamlSafeDescription = '|\n' + rawDescription
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');

  return `---
title: "${safeString(metadata.title)}"
date: ${safeString(metadata.date)}
category: ${safeString(metadata.category)}
description: ${yamlSafeDescription}
image: '${safeString(metadata.image)}'
duration: ${safeString(metadata.duration)}
tags:
${tags.map(tag => `  - ${tag}`).join('\n')}
canonical_url: ${safeString(metadata.canonical_url)}
author: ${safeString(metadata.author)}
video_author: ${safeString(metadata.video_author)}
video_url: ${safeString(metadata.video_url)}
video_id: ${videoID}
published_date: ${safeString(metadata.published_date)}
---
![](https://www.youtube.com/watch?v=${videoID})
# ${safeString(metadata.title)}\n`;
}

function createSmartSummaryV3Handler(deps) {
  const {
    admin,
    ytdl,
    modelUrls,
    postWithRetry,
    buildTagsFromText,
    logger,
    summaryDebug,
  } = deps;
  const summaryConfig = createSummaryConfig(process.env);
  const metrics = createMetrics();
  const asyncJobStore = createAsyncJobStore();

  async function callModel({ modelUrl, model, payload, stage }) {
    let lastError;
    for (let attempt = 0; attempt <= summaryConfig.stageRetries; attempt += 1) {
      try {
        return await withTimeout(
          postWithRetry(modelUrl, payload, {
            maxAttempts: 1,
            baseDelayMs: 250,
            axiosOptions: { timeout: summaryConfig.stageTimeoutMs },
          }),
          summaryConfig.stageTimeoutMs,
          `${stage}-attempt-${attempt + 1}`,
        );
      } catch (error) {
        if (isUpstreamTranscriptNotFound(error) && typeof payload?.transcript === 'string' && payload.transcript.trim()) {
          const fallbackUrl = resolveFallbackModelUrl(modelUrl, model);
          if (fallbackUrl) {
            const fallbackMessages = [
              { role: 'system', content: DIRECT_SUMMARY_PROMPT },
              { role: 'user', content: payload.transcript },
            ];
            try {
              return await withTimeout(
                postWithRetry(fallbackUrl, { modelMessages: fallbackMessages }, {
                  maxAttempts: 1,
                  baseDelayMs: 250,
                  axiosOptions: { timeout: summaryConfig.stageTimeoutMs },
                }),
                summaryConfig.stageTimeoutMs,
                `${stage}-fallback-attempt-${attempt + 1}`,
              );
            } catch (fallbackError) {
              lastError = fallbackError;
            }
          }
        }
        lastError = error;
        if (!shouldRetryError(error) || attempt >= summaryConfig.stageRetries) break;
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async function executeSummary({ body, requestId }) {
    const startedAt = Date.now();
    const payloadBytes = Buffer.byteLength(JSON.stringify(body || {}), 'utf8');
    metrics.inc('total');
    try {
      const { url, model, transcript: inlineTranscript } = body || {};
      if (!url) {
        const err = new Error('URL is required');
        err.status = 400;
        throw err;
      }
      if (!model) {
        const err = new Error('Model is required');
        err.status = 400;
        throw err;
      }

      const modelUrl = modelUrls[model];
      if (!modelUrl) {
        const err = new Error('Invalid model specified');
        err.status = 400;
        throw err;
      }

      let videoID;
      try {
        videoID = ytdl.getURLVideoID(url);
      } catch (_) {
        const err = new Error('Invalid YouTube URL');
        err.status = 400;
        throw err;
      }

      const db = admin.firestore();
      const summariesRef = db.collection('summaries').doc(videoID);
      const transcriptRef = db.collection('transcripts').doc(videoID);

      const summarySnap = await summariesRef.get();
      if (summarySnap.exists) {
        const cached = summarySnap.data();
        if (cached.summary) {
          const durationMs = Date.now() - startedAt;
          metrics.inc('success');
          metrics.observeDuration(durationMs);
          logger.info('smart-summary-v3 cache-hit', JSON.stringify({ requestId, videoID, durationMs }));
          return { status: 200, body: { summary: cached.summary, fromCache: true, requestId } };
        }
      }

      const transcriptSnap = await transcriptRef.get();
      if (!transcriptSnap.exists) {
        const err = new Error('Transcript not found for this video.');
        err.status = 404;
        throw err;
      }

      const metadata = transcriptSnap.data();
      const transcript = typeof inlineTranscript === 'string' && inlineTranscript.trim()
        ? inlineTranscript.trim()
        : safeString(metadata.transcript).trim();
      if (!transcript) {
        const err = new Error('Transcript is missing. Generate transcript first or provide transcript in request.');
        err.status = 422;
        throw err;
      }

      const transcriptLength = transcript.length;
      logger.info(
        `smart-summary-v3 request ${JSON.stringify({
          requestId,
          videoID,
          payloadBytes,
          transcriptLength,
          maxTranscriptChars: summaryConfig.maxTranscriptChars,
        })}`,
      );

      if (transcriptLength > summaryConfig.maxTranscriptChars) {
        metrics.inc('payloadTooLargeRejects');
        const err = new Error(
          `Transcript exceeds allowed size (${transcriptLength} > ${summaryConfig.maxTranscriptChars} chars).`,
        );
        err.status = 413;
        err.clientCode = 'TRANSCRIPT_TOO_LARGE';
        err.receivedChars = transcriptLength;
        err.maxChars = summaryConfig.maxTranscriptChars;
        throw err;
      }

      const stageDurations = {};
      let tags = Array.isArray(metadata.tags) ? metadata.tags : [];
      let summaryText = '';
      let chunkCount = 1;
      let mode = 'direct';

      if (transcriptLength <= summaryConfig.directTranscriptChars) {
        const stageStart = Date.now();
        const response = await callModel({
          modelUrl,
          model,
          payload: { transcript, videoID },
          stage: 'direct-summary',
        });
        stageDurations.directMs = Date.now() - stageStart;
        summaryText = parseModelSummary(response.data, model);
        if (!summaryText) {
          const err = new Error('Model did not return a summary');
          err.status = 502;
          throw err;
        }
        if (tags.length === 0) {
          tags = parseTags(response.data?.tags);
          if (tags.length === 0) {
            tags = buildTagsFromText([metadata.title, metadata.description, summaryText].filter(Boolean).join(' '));
          }
        }
      } else {
        mode = 'chunked';
        const chunks = splitTranscriptIntoChunks({
          transcript,
          targetChars: summaryConfig.chunkTargetChars,
          overlapChars: summaryConfig.chunkOverlapChars,
        });
        chunkCount = chunks.length;
        if (chunkCount > summaryConfig.maxChunks) {
          const err = new Error(
            `Transcript is too large for processing (chunks=${chunkCount}, max=${summaryConfig.maxChunks}).`,
          );
          err.status = 413;
          err.clientCode = 'TRANSCRIPT_TOO_LARGE';
          throw err;
        }

        const chunkSummaries = [];
        const chunkResponses = [];
        for (let i = 0; i < chunks.length; i += 1) {
          const stageStart = Date.now();
          const response = await callModel({
            modelUrl,
            model,
            payload: { transcript: chunks[i], videoID },
            stage: `chunk-${i + 1}`,
          });
          const chunkSummary = parseModelSummary(response.data, model);
          if (!chunkSummary) {
            const err = new Error(`Chunk ${i + 1} did not return a summary`);
            err.status = 502;
            throw err;
          }
          chunkResponses.push(response.data || {});
          chunkSummaries.push(`Chunk ${i + 1}:\n${chunkSummary}`);
          stageDurations[`chunk${i + 1}Ms`] = Date.now() - stageStart;
          logger.info(
            `smart-summary-v3 chunk-complete ${JSON.stringify({ requestId, chunkIndex: i + 1, chunkCount, durationMs: stageDurations[`chunk${i + 1}Ms`] })}`,
          );
        }

        if (chunkCount === 1) {
          summaryText = parseModelSummary(chunkResponses[0], model);
          if (!summaryText) {
            const err = new Error('Single chunk summary returned empty output');
            err.status = 502;
            throw err;
          }
          if (tags.length === 0) {
            tags = parseTags(chunkResponses[0]?.tags);
            if (tags.length === 0) {
              tags = buildTagsFromText([metadata.title, metadata.description, summaryText].filter(Boolean).join(' '));
            }
          }
        } else {
          const summarizeChunksStart = Date.now();
          const finalResponse = await callModel({
            modelUrl,
            model,
            payload: { transcript: chunkSummaries.join('\n\n'), videoID },
            stage: 'final-summary',
          });
          stageDurations.finalSummaryMs = Date.now() - summarizeChunksStart;
          summaryText = parseModelSummary(finalResponse.data, model);
          if (!summaryText) {
            const err = new Error('Final summary stage returned empty output');
            err.status = 502;
            throw err;
          }
          if (tags.length === 0) {
            tags = parseTags(finalResponse.data?.tags);
            if (tags.length === 0) {
              tags = buildTagsFromText([metadata.title, metadata.description, summaryText].filter(Boolean).join(' '));
            }
          }
        }
      }

      const frontmatter = buildSummaryFrontmatter({ metadata, tags, videoID });
      const summaryWithFrontmatter = `${frontmatter}${summaryText}`;

      await summariesRef.set(
        {
          summary: summaryWithFrontmatter,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          tags,
        },
        { merge: true },
      );

      const durationMs = Date.now() - startedAt;
      metrics.inc('success');
      metrics.observeDuration(durationMs);
      logger.info(
        `smart-summary-v3 success ${JSON.stringify({
          requestId,
          videoID,
          payloadBytes,
          transcriptLength,
          mode,
          chunkCount,
          durationMs,
          stageDurations,
          metrics: metrics.snapshot(),
        })}`,
      );

      if (summaryDebug) {
        logger.info('smart-summary-v3 debug', JSON.stringify({ requestId, stageDurations }));
      }
      return {
        status: 200,
        body: { summary: summaryWithFrontmatter, fromCache: false, requestId, mode, chunkCount },
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const mapped = mapSummaryFailure(error);
      if (mapped.status >= 500) metrics.inc('errors5xx');
      if (error?.code === 'timeout') metrics.inc('timeouts');
      metrics.observeDuration(durationMs);
      logger.error(
        `smart-summary-v3 failed ${JSON.stringify({
          requestId,
          status: mapped.status,
          code: mapped.code,
          durationMs,
          reason: error?.message || 'unknown',
          upstreamStatus: error?.response?.status,
          upstreamBody: error?.response?.data,
          metrics: metrics.snapshot(),
        })}`,
      );
      return {
        status: mapped.status,
        body: {
        error: 'Summary generation failed',
        code: mapped.code,
        message: mapped.message,
        requestId,
          ...(error?.receivedChars ? { receivedChars: error.receivedChars } : {}),
          ...(error?.maxChars ? { maxChars: error.maxChars } : {}),
        },
      };
    }
  }

  async function smartSummaryV3Handler(req, res) {
    const requestId = getRequestId(req);
    const asyncRequested = String(req.query?.async || '').toLowerCase();
    const shouldQueue = asyncRequested === '1' || asyncRequested === 'true'
      || String(req.headers?.prefer || '').toLowerCase().includes('respond-async');

    if (shouldQueue) {
      asyncJobStore.create(requestId);
      setImmediate(async () => {
        asyncJobStore.start(requestId);
        const result = await executeSummary({ body: req.body || {}, requestId });
        if (result.status >= 200 && result.status < 300) {
          asyncJobStore.succeed(requestId, result.body);
        } else {
          asyncJobStore.fail(requestId, result.body);
        }
      });

      return res.status(202).json({
        requestId,
        status: 'queued',
        statusUrl: `/summary-status/${requestId}`,
      });
    }

    const result = await executeSummary({ body: req.body || {}, requestId });
    return res.status(result.status).json(result.body);
  }

  smartSummaryV3Handler.submitAsyncHandler = async (req, res) => {
    const requestId = getRequestId(req);
    asyncJobStore.create(requestId);
    setImmediate(async () => {
      asyncJobStore.start(requestId);
      const result = await executeSummary({ body: req.body || {}, requestId });
      if (result.status >= 200 && result.status < 300) {
        asyncJobStore.succeed(requestId, result.body);
      } else {
        asyncJobStore.fail(requestId, result.body);
      }
    });
    return res.status(202).json({
      requestId,
      status: 'queued',
      statusUrl: `/summary-status/${requestId}`,
    });
  };

  smartSummaryV3Handler.getStatusHandler = async (req, res) => {
    const requestId = req.params?.requestId;
    if (!requestId) {
      return res.status(400).json({ error: 'Missing requestId', code: 'REQUEST_ID_REQUIRED' });
    }
    const job = asyncJobStore.get(requestId);
    if (!job) {
      return res.status(404).json({
        error: 'Summary request not found or expired',
        code: 'SUMMARY_REQUEST_NOT_FOUND',
        requestId,
      });
    }

    if (job.status === 'succeeded') {
      return res.status(200).json({ requestId, status: job.status, result: job.result });
    }
    if (job.status === 'failed') {
      return res.status(200).json({ requestId, status: job.status, error: job.error });
    }

    return res.status(200).json({
      requestId,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  };

  return smartSummaryV3Handler;
}

function smartSummaryJsonErrorHandler(err, req, res, next) {
  if (!req.path || req.path !== '/smart-summary-firebase-v3') {
    return next(err);
  }

  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return res.status(413).json({
      error: 'Payload too large',
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body exceeds JSON size limit. Send a smaller payload or omit inline transcript.',
    });
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'Invalid JSON',
      code: 'INVALID_JSON',
      message: 'Request body is not valid JSON.',
    });
  }

  return res.status(500).json({
    error: 'Internal server error',
    code: 'SMART_SUMMARY_ROUTE_ERROR',
    message: 'Unexpected error while processing summary request.',
  });
}

module.exports = {
  createSummaryConfig,
  splitTranscriptIntoChunks,
  mapSummaryFailure,
  createSmartSummaryV3Handler,
  smartSummaryJsonErrorHandler,
};
