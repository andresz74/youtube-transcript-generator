const axios = require('axios');
const TranscriptAPI = require('youtube-transcript-api');
const ytdl = require('ytdl-core');
const he = require('he');
const fs = require('fs');
const path = require('path');

function loadCookieHeader() {
  try {
    const cookiePath = path.resolve(__dirname, 'all_cookies.txt');
    const raw = fs.readFileSync(cookiePath, 'utf-8');
    const cookiePairs = raw
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => line.split('\t'))
      .filter(parts => parts.length >= 7)
      .map(parts => `${parts[5]}=${parts[6]}`);
    return cookiePairs.length ? cookiePairs.join('; ') : '';
  } catch (err) {
    return '';
  }
}

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

async function fetchTranscriptPrimary(videoID, language) {
  const cookieHeader = loadCookieHeader();
  const requestHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.youtube.com/',
    ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
  };

  // 1) first, try the easy library
  try {
    const raw = await TranscriptAPI.getTranscript(videoID, language);
    if (!raw.length) throw new Error('empty');
    return raw.map(({ text, start, duration }) => ({ text, start, dur: duration }));
  } catch (err) {
    const status = err.response?.status;
    console.warn('⚠️ TranscriptAPI failed, falling back to manual scrape:', err.message, status ? `(status ${status})` : '');
  }

  // 2) fallback: scrape YouTube’s signed URL yourself
  console.log('>>> fallback');
  const info = await ytdl.getBasicInfo(`https://youtube.com/watch?v=${videoID}`, {
    requestOptions: { headers: requestHeaders }
  });
  const tracks = info.player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) {
    throw new Error('No captionTracks available to scrape.');
  }

  // pick our language (or default to first)
  const track = tracks.find(t => t.languageCode === language) || tracks[0];
  // ✅ use the original signed URL exactly as given
  const url = track.baseUrl;

  // fetch with browser-like headers
  let xml;
  try {
    const response = await axios.get(url, { headers: requestHeaders });
    xml = response.data;
  } catch (err) {
    const status = err.response?.status;
    const details = err.response?.data || err.message;
    throw new Error(`Manual scrape failed${status ? ` (status ${status})` : ''}: ${details}`);
  }
  console.log('Manual scrape URL:', url);
  console.log('Raw XML length:', xml.length);
  console.log('Raw XML preview:', xml.slice(0, 300).replace(/\n/g, ''));

  let lines = parseTranscriptXml(xml);
  if (!lines.length) {
    try {
      const jsonUrl = url.includes('fmt=') ? url : `${url}&fmt=json3`;
      const response = await axios.get(jsonUrl, { headers: requestHeaders });
      const jsonLines = parseTranscriptJson3(response.data);
      if (jsonLines.length) {
        console.log('Manual scrape JSON3 lines:', jsonLines.length);
        return jsonLines;
      }
    } catch (jsonError) {
      console.warn('Manual scrape JSON3 failed:', jsonError.message);
    }
  }
  if (!lines.length) {
    throw new Error('Manual scrape returned empty transcript.');
  }
  return lines;
}

async function fetchTranscriptLegacy(videoID, language) {
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

async function fetchTranscript(videoID, language) {
  try {
    return await fetchTranscriptPrimary(videoID, language);
  } catch (primaryError) {
    console.warn('Primary fetchTranscript failed, attempting legacy fallback:', primaryError.message);
    return await fetchTranscriptLegacy(videoID, language);
  }
}

module.exports = {
  fetchTranscript,
  fetchTranscriptPrimary,
  fetchTranscriptLegacy,
};
