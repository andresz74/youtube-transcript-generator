const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const tmp = require('tmp-promise');

function removeVttTags(text) {
  return text.replace(/<[^>]*>/g, '');
}

function isTimestamp(line) {
  return /^\d+$/.test(line) || /^\d{2}:\d{2}:\d{2}/.test(line);
}

function cleanVttContent(content) {
  const lines = content.split('\n');
  const output = [];

  for (let line of lines) {
    line = line.trim();
    if (
      !line ||
      line === 'WEBVTT' ||
      line.includes('-->') ||
      line.startsWith('NOTE') ||
      line.startsWith('STYLE') ||
      line.startsWith('Kind:') ||
      line.startsWith('Language:') ||
      isTimestamp(line)
    ) continue;

    const clean = removeVttTags(line);
    if (clean) output.push(clean);
  }

  return output.join(' ');
}

function parseTranscriptJson3(json) {
  const events = json?.events || [];
  return events
    .filter(event => Array.isArray(event.segs))
    .map(event => {
      const text = event.segs.map(seg => seg.utf8 || '').join('');
      const start = (event.tStartMs || 0) / 1000;
      const dur = (event.dDurationMs || 0) / 1000;
      return { start, dur, text: text.trim() };
    })
    .filter(line => line.text);
}

async function readFirstFileByExtension(dirPath, ext) {
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith(ext));
  if (files.length === 0) return null;
  return path.join(dirPath, files[0]);
}

async function fabricFetchTranscript(videoID, lang = 'en') {
  console.log('===> fabricFetchTranscript')
  if (!videoID) throw new Error('Missing YouTube URL');

  const { path: tmpDirPath, cleanup } = await tmp.dir({ unsafeCleanup: true });
  const outputPath = path.join(tmpDirPath, '%(id)s.%(ext)s');

  const args = [
    '--cookies', path.resolve(__dirname, 'all_cookies.txt'),
    '--js-runtimes', 'deno',
    '--write-auto-subs',
    '--sub-lang', lang,
    '--skip-download',
    '--sub-format', 'json3/vtt',
    '--quiet',
    '--no-warnings',
    '-o', outputPath,
    `https://youtube.com/watch?v=${videoID}`
  ];

  try {
    await new Promise((resolve, reject) => {
      execFile('yt-dlp', args, (error, stdout, stderr) => {
        if (error) return reject(new Error(`yt-dlp failed: ${stderr}`));
        resolve();
      });
    });

    const jsonPath = await readFirstFileByExtension(tmpDirPath, '.json3');
    if (jsonPath) {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const parsed = parseTranscriptJson3(JSON.parse(content));
      if (parsed.length) {
        return parsed.map(item => item.text).join(' ');
      }
    }

    const vttPath = await readFirstFileByExtension(tmpDirPath, '.vtt');
    if (vttPath) {
      const content = fs.readFileSync(vttPath, 'utf-8');
      return cleanVttContent(content);
    }

    throw new Error('No JSON3 or VTT subtitles found');
  } finally {
    cleanup();
  }
}

module.exports = { fabricFetchTranscript };
