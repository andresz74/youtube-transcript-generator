const axios = require('axios');
const TranscriptAPI = require('youtube-transcript-api');
const ytdl = require('ytdl-core');
const he = require('he');

// helper to fetch and normalize a transcript
function parseTranscriptXml(xml) {
  return xml
    .replace('<?xml version="1.0" encoding="utf-8" ?><transcript>', '')
    .replace('</transcript>', '')
    .split('</text>')
    .filter(line => line.trim())
    .map(line => {
      const start = line.match(/start="([\d.]+)"/)[1];
      const dur = line.match(/dur="([\d.]+)"/)[1];
      let txt = line.replace(/<text.+?>/, '').replace(/<\/?[^>]+(>|$)/g, '');
      txt = he.decode(txt.replace(/&amp;/g, '&'));
      return { start, dur, text: txt };
    });
}

async function fetchTranscript(videoID, language) {
  // 1) first, try the easy library
  try {
    const raw = await TranscriptAPI.getTranscript(videoID, language);
    if (!raw.length) throw new Error('empty');
    return raw.map(({ text, start, duration }) => ({ text, start, dur: duration }));
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    if (!/video unavailable|captions disabled|empty/.test(msg)) {
      // some other error (network, bad ID)… re-throw
      throw err;
    }
    console.warn('⚠️ TranscriptAPI failed, falling back to manual scrape:', err.message);
  }

  // 2) fallback: scrape YouTube’s signed URL yourself
  console.log('>>> fallback');
  const info = await ytdl.getBasicInfo(`https://youtube.com/watch?v=${videoID}`);
  const tracks = info.player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) {
    throw new Error('No captionTracks available to scrape.');
  }

  // pick our language (or default to first)
  const track = tracks.find(t => t.languageCode === language) || tracks[0];
  // ✅ use the original signed URL exactly as given
  const url = track.baseUrl;

  // fetch with browser-like headers
  const { data: xml } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.youtube.com/',
    }
  });
  console.log('Manual scrape URL:', url);
  console.log('Raw XML length:', xml.length);
  console.log('Raw XML preview:', xml.slice(0, 300).replace(/\n/g, ''));

  const lines = parseTranscriptXml(xml);
  if (!lines.length) {
    throw new Error('Manual scrape returned empty transcript.');
  }
  return lines;
}

module.exports = { fetchTranscript };
