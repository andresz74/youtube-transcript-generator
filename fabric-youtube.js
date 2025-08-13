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

async function fabricFetchTranscript(videoID, lang = 'en') {
  console.log('===> fabricFetchTranscript')
  if (!videoID) throw new Error('Missing YouTube URL');

  const { path: tmpDirPath, cleanup } = await tmp.dir({ unsafeCleanup: true });
  const outputPath = path.join(tmpDirPath, '%(title)s.%(ext)s');

  const args = [
    '--cookies', path.resolve(__dirname, 'all_cookies.txt'),
    '--write-auto-subs',
    '--sub-lang', lang,
    '--skip-download',
    '--sub-format', 'vtt',
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

    const files = fs.readdirSync(tmpDirPath).filter(f => f.endsWith('.vtt'));
    if (files.length === 0) throw new Error('No VTT subtitles found');

    const vttPath = path.join(tmpDirPath, files[0]);
    const content = fs.readFileSync(vttPath, 'utf-8');
    return cleanVttContent(content);
  } finally {
    cleanup();
  }
}

module.exports = { fabricFetchTranscript };
