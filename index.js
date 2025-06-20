require('dotenv').config();

const axios = require('axios');
const express = require('express');
const cors = require('cors');
const logger = require('./logger');
const ytdl = require('ytdl-core');
const getSubtitles = require('youtube-captions-scraper').getSubtitles;
const TranscriptAPI = require('youtube-transcript-api');

// Firebase Admin SDK
const admin = require('firebase-admin');
const serviceAccount = require('./firebaseServiceAccount.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
app.use(cors());

// Increase the limit for JSON body parsing
app.use(express.json({ limit: '50mb' }));  // Adjust this value as needed

app.use((req, res, next) => {
  console.log('Request size:', req.headers['content-length']);  // Log the content-length of each request
  next();
});

app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const referer = req.headers['referer'] || 'None';

  logger.info(`Endpoint Hit: ${req.method} ${req.originalUrl} - IP: ${ip} - UA: ${userAgent} - Ref: ${referer} - ${new Date().toISOString()}`);

  next();
});

/**
 * GET /health
 * A simple health check endpoint to verify that the service is running.
 * 
 * Response:
 *   200: 'OK' message indicating the server is operational.
 */
app.get('/health', (req, res) => {
  res.send('OK');
});

/**
 * GET /debug
 * Provides debug information, including the client's IP and the server's region.
 * Useful for debugging and monitoring.
 * 
 * Response:
 *   200: JSON object with `ip` and `region`.
 */
app.get('/debug', (req, res) => {
  res.json({
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    region: process.env.VERCEL_REGION || 'local',
  });
});

// helper to fetch and normalize a transcript
function parseTranscriptXml(xml) {
  return xml
    .replace('<?xml version="1.0" encoding="utf-8" ?><transcript>', '')
    .replace('</transcript>', '')
    .split('</text>')
    .filter(line => line.trim())
    .map(line => {
      const start = line.match(/start="([\d.]+)"/)[1];
      const dur   = line.match(/dur="([\d.]+)"/)[1];
      let   txt   = line.replace(/<text.+?>/, '').replace(/<\/?[^>]+(>|$)/g, '');
      txt = he.decode(txt.replace(/&amp;/g, '&'));
      return { start, dur, text: txt };
    });
}

async function fetchTranscript(videoId, language) {
  // 1) first, try the easy library
  try {
    const raw = await TranscriptAPI.getTranscript(videoId, language);
    if (!raw.length) throw new Error('empty');
    return raw.map(({ text, start, duration }) => ({ text, start, dur: duration }));
  } catch (err) {
    const msg = (err.message||'').toLowerCase();
    if (!/video unavailable|captions disabled|empty/.test(msg)) {
      // some other error (network, bad ID)… re-throw
      throw err;
    }
    console.warn('⚠️ TranscriptAPI failed, falling back to manual scrape:', err.message);
  }

  // 2) fallback: scrape YouTube’s signed URL yourself
  console.log('>>> fallback');
  const info = await ytdl.getBasicInfo(`https://youtube.com/watch?v=${videoId}`);
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
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer':         'https://www.youtube.com/',
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

/**
 * POST /transcript
 * Retrieves full video info and timestamped captions (subtitles) in all available languages.
 * 
 * Request Body:
 *   url (string): The URL of the YouTube video to fetch the transcript for.
 * 
 * Response:
 *   200: JSON object containing video info, available languages for captions, and the transcripts in each language.
 *   400: Invalid YouTube URL.
 *   404: Video not found or no captions available for the video.
 */
app.post('/transcript', async (req, res) => {
  try {
    const { url } = req.body;

    // Check if the video is a YouTube Short (specific format for Shorts videos)
    const isShort = url.includes('/shorts/');
    console.log('isShort:', isShort);

    // Extract video ID from URL
    const videoId = ytdl.getURLVideoID(url);
    if (!videoId) {
      return res.status(400).json({ message: 'Invalid YouTube URL' });
    }

    // Get video info (e.g., title, author, etc.)
    const videoInfo = await ytdl.getBasicInfo(url);
    if (!videoInfo || !videoInfo.videoDetails) {
      return res.status(404).json({ status: 404, message: 'Video not found' });
    }

    // Log the video info to check its structure
    console.log('Video Info:', videoInfo);

    // Ensure player_response and captions are available
    const playerResponse = videoInfo.player_response;
    if (!playerResponse || !playerResponse.captions || !playerResponse.captions.playerCaptionsTracklistRenderer) {
      return res.status(404).json({ message: 'No captions available for this video.', videoInfo });
    }

    // Fetch available captions (subtitles) from the video info
    const captionTracks = videoInfo.player_response.captions.playerCaptionsTracklistRenderer.captionTracks;
    console.log('Caption Tracks:', captionTracks);

    if (!captionTracks || captionTracks.length === 0) {
      return res.status(404).json({ message: 'No captions available for this video.' });
    }

    // Select the first available caption track (or choose another based on your needs)
    const languageCode = captionTracks[0].languageCode;

    // Fetch the transcript in the selected language
    const transcript = await getSubtitles({
      videoID: videoId, // YouTube video ID
      lang: languageCode // Use the language code of the first available caption
    });

    // Prepare the response in the desired format
    const response = {
      status: 'success',
      status_code: 200,
      code: 100000,
      message: 'success',
      data: {
        videoId: videoId,
        videoInfo: videoInfo,
        videoInfoSummary: {
          name: videoInfo.videoDetails.title,
          thumbnailUrl: {
            hqdefault: videoInfo.videoDetails.thumbnails[0].url,
          },
          embedUrl: `https://www.youtube.com/embed/${videoId}`,
          duration: videoInfo.videoDetails.lengthSeconds,
          description: videoInfo.videoDetails.description,
          upload_date: videoInfo.videoDetails.publishDate,
          genre: videoInfo.videoDetails.category,
          author: videoInfo.videoDetails.author.name,
          channel_id: videoInfo.videoDetails.channelId,
        },
        language_code: captionTracks.map(caption => ({
          code: caption.languageCode,
          name: caption.name.simpleText
        })),
        transcripts: captionTracks.reduce((acc, caption) => {
          // Only retrieve transcripts for available languages
          acc[caption.languageCode] = {
            custom: transcript.map((item) => ({
              start: item.start,
              end: item.start + item.dur,
              text: item.text
            }))
          };
          return acc;
        }, {})
      }
    };

    // Send response
    res.json(response);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'An error occurred while fetching the transcript.' });
  }
});

/**
 * POST /simple-transcript
 * Returns only the video title and a concatenated string of subtitles in the first available language.
 * 
 * Request Body:
 *   url (string): The URL of the YouTube video.
 * 
 * Response:
 *   200: JSON object containing `duration`, `title`, and `transcript`.
 *   404: No captions available for this video.
 */
app.post('/simple-transcript', async (req, res) => {
  try {
    const { url } = req.body;

    // Extract video ID from URL
    const videoId = ytdl.getURLVideoID(url);

    // Get video info (e.g., duration)
    const videoInfo = await ytdl.getBasicInfo(url);
    const duration = Math.floor(videoInfo.videoDetails.lengthSeconds / 60); // Convert to minutes

    // Fetch available captions (subtitles) from the video info
    const captionTracks = videoInfo.player_response.captions.playerCaptionsTracklistRenderer.captionTracks;
    console.log('Caption Tracks:', captionTracks);

    if (!captionTracks || captionTracks.length === 0) {
      return res.status(404).json({ message: 'No captions available for this video.' });
    }

    // Select the first available caption track
    const languageCode = captionTracks[0].languageCode;

    // Fetch the transcript in the selected language
    const transcript = await getSubtitles({
      videoID: videoId,
      lang: languageCode // Use the language code of the first available caption
    });

    if (!transcript || transcript.length === 0) {
      throw new Error(`No captions available in the selected language (${languageCode}).`);
    }

    // Combine all transcript items into a single string
    const transcriptText = transcript.map(item => item.text).join(' ');

    // Prepare the simple response format
    const response = {
      duration: duration,
      title: videoInfo.videoDetails.title,
      transcript: transcriptText
    };

    // Send the simplified transcript response
    res.json(response);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'An error occurred while fetching the simple transcript.' });
  }
});

app.post('/simple-transcript-v2', async (req, res) => {
  try {
    const { url, lang } = req.body;
    console.log('URL:', url, ', Language:', lang);
    // Check if the video is a YouTube Short (specific format for Shorts videos)
    const isShort = url.includes('/shorts/');
    console.log('isShort:', isShort);

    // Extract video ID from URL
    const videoId = ytdl.getURLVideoID(url);

    // Get video info (e.g., duration)
    const videoInfo = await ytdl.getBasicInfo(url);
    const duration = Math.floor(videoInfo.videoDetails.lengthSeconds / 60); // Convert to minutes

    // Fetch available captions (subtitles) from the video info
    const captionTracks = videoInfo.player_response.captions.playerCaptionsTracklistRenderer.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      return res.status(404).json({ message: 'No captions available for this video.' });
    }
    if (lang) {
      // Create an array to store languages
      const languages = captionTracks.map(track => ({
        name: track.name.simpleText,
        code: track.languageCode
      }));
      // Check if the requested language is available
      const langTrack = captionTracks.find(track => track.languageCode === lang);
      if (!langTrack) {
        return res.status(404).json({ message: `No captions available in the requested language (${lang}).` });
      } else {
        // Fetch the transcript in the requested language
        const transcript = await getSubtitles({
          videoID: videoId,
          lang: lang // Use the requested language code
        });
        if (!transcript || transcript.length === 0) {
          throw new Error(`No captions available in the requested language (${lang}).`);
        }
        // Combine all transcript items into a single string
        const transcriptText = transcript.map(item => item.text).join(' ');
        // Prepare the simple response format
        const response = {
          duration: duration,
          title: videoInfo.videoDetails.title,
          transcript: transcriptText,
          transcriptLanguageCode: lang,
          languages: languages.length > 1 ? languages : undefined, // Only include if more than one language
          videoInfoSummary: {
            author: videoInfo.videoDetails.author,
            description: videoInfo.videoDetails.description,
            embed: videoInfo.videoDetails.embed,
            thumbnails: videoInfo.videoDetails.thumbnails,
            viewCount: videoInfo.videoDetails.viewCount,
            publishDate: videoInfo.videoDetails.publishDate,
            video_url: videoInfo.videoDetails.video_url,
          }
        };
        // Send the simplified transcript response
        res.json(response);
        return;
      }
    }
    // Create an array to store languages
    const languages = captionTracks.map(track => ({
      name: track.name.simpleText,
      code: track.languageCode
    }));

    // Try to find English subtitles (preferably non-auto-generated)
    let englishTrack = captionTracks.find(track => track.languageCode.startsWith('en') && track.kind !== 'asr')
      || captionTracks.find(track => track.languageCode.startsWith('en'));

    // If no English subtitles, fetch the transcript of the first available caption track
    let transcriptText = '';
    let transcriptLanguageCode = '';
    if (englishTrack) {
      transcriptLanguageCode = englishTrack.languageCode;
      // Fetch the transcript in English if available
      const transcript = await getSubtitles({
        videoID: videoId,
        lang: 'en' // Fetch English captions
      });

      if (transcript && transcript.length > 0) {
        transcriptText = transcript.map(item => item.text).join(' ');
      } else {
        throw new Error(`No English captions available.`);
      }
    } else {
      transcriptLanguageCode = captionTracks[0].languageCode; // Fallback to the first available track
      // Fetch the transcript in the first available language
      const firstAvailableTrack = captionTracks[0]; // First available track
      const firstLanguageCode = firstAvailableTrack.languageCode;

      const transcript = await getSubtitles({
        videoID: videoId,
        lang: firstLanguageCode // Fetch captions in the first available language
      });

      if (transcript && transcript.length > 0) {
        transcriptText = transcript.map(item => item.text).join(' ');
      } else {
        throw new Error(`No captions available in the first language.`);
      }
    }

    // Prepare the simple response format
    const response = {
      duration: duration,
      title: videoInfo.videoDetails.title,
      transcript: transcriptText,
      transcriptLanguageCode: transcriptLanguageCode,
      languages: languages.length > 1 ? languages : undefined, // Only include if more than one language
      videoInfoSummary: {
        author: videoInfo.videoDetails.author,
        description: videoInfo.videoDetails.description,
        embed: videoInfo.videoDetails.embed,
        thumbnails: videoInfo.videoDetails.thumbnails,
        viewCount: videoInfo.videoDetails.viewCount,
        publishDate: videoInfo.videoDetails.publishDate,
        video_url: videoInfo.videoDetails.video_url,
      }
    };

    // Send the simplified transcript response with languages if more than one
    res.json(response);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'An error occurred while fetching the simple transcript.' });
  }
});

/**
 * POST /simple-transcript-v3
 * Fetches and returns the video title and concatenated transcript for a requested language (or default language if none requested).
 * Caches transcripts by video ID and language in Firestore for faster future access.
 * 
 * Request Body:
 *   url (string): The URL of the YouTube video.
 *   lang (string, optional): The language code to fetch the transcript in (e.g., "en", "es", "en-US").
 * 
 * Response:
 *   200: JSON object containing:
 *     - videoID (string): The YouTube video ID.
 *     - duration (number): The video duration in minutes.
 *     - title (string): The title of the video.
 *     - transcript (string): The concatenated transcript text in the selected or default language.
 *     - transcriptLanguageCode (string): The language code of the returned transcript.
 *     - languages (array, optional): Array of available languages (only included if more than one language is available).
 *     - videoInfoSummary (object): Basic video metadata (author, description, embed info, thumbnails, view count, publish date, video URL).
 * 
 *   404: No captions available for this video or in the requested language.
 * 
 *   500: An error occurred while fetching or saving the transcript.
 */

async function safeGetVideoInfo(url) {
  try {
    return await ytdl.getBasicInfo(url);
  } catch (err) {
    if (err.message.includes('private video')) {
      return null; // signal to caller
    }
    throw err;
  }
}

app.post('/simple-transcript-v3', async (req, res) => {
  try {
    const { url, lang } = req.body;
    console.log('URL:', url, ', Language:', lang);

    const videoId = ytdl.getURLVideoID(url);
    const docRef = db.collection('transcripts-multilingual').doc(videoId);
    const doc = await docRef.get();

    // ------------------------------
    // If cached transcript exists → use it
    // ------------------------------
    if (doc.exists) {
      console.log(`Transcript found in Firebase for ${videoId}`);
      const cached = doc.data();
      const availableLanguages = cached.availableLanguages;

      let cachedTranscript = null;

      // Find exact or prefix match if lang is provided
      if (lang) {
        cachedTranscript = cached.transcript.find(t => t.language === lang)
          || cached.transcript.find(t => t.language.startsWith(lang));
      }

      if (!lang) {
        // No lang requested → fallback to first cached transcript
        cachedTranscript = cached.transcript[0];

        return res.json({
          videoID: cached.videoID,
          duration: cached.duration,
          title: cachedTranscript.title,
          transcript: cachedTranscript.transcript,
          transcriptLanguageCode: cachedTranscript.language,
          languages: availableLanguages.length > 0 ? availableLanguages : undefined
        });
      }

      if (cachedTranscript) {
        // Lang requested and cached → return cached
        return res.json({
          videoID: cached.videoID,
          duration: cached.duration,
          title: cachedTranscript.title,
          transcript: cachedTranscript.transcript,
          transcriptLanguageCode: cachedTranscript.language,
          languages: availableLanguages.length > 0 ? availableLanguages : undefined
        });
      }

      // 🚨 Lang requested and NOT cached → FETCH FROM YOUTUBE
      const videoInfo = await safeGetVideoInfo(url);
      if (!videoInfo) {
        return res.status(403).json({ message: 'This is a private video. Cannot fetch transcript.' });
      }

      // const transcriptText = await getSubtitles({ videoID: videoId, lang });
      // lines is your array of { start, dur, text }
      const lines = await fetchTranscript(videoId, selectedLanguageCode);

      // build a single string
      const transcriptTextJoined = lines.map(item => item.text).join(' ');
      console.log('>>> 1 fetchTranscript');

      // Update transcript array
      const transcriptArray = cached.transcript;
      transcriptArray.push({
        language: lang,
        title: videoInfo.videoDetails.title,
        transcript: transcriptTextJoined
      });

      // Save updated array
      await docRef.set({
        videoID: cached.videoID,
        duration: cached.duration,
        transcript: transcriptArray,
        availableLanguages: availableLanguages,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.json({
        videoID: cached.videoID,
        duration: cached.duration,
        title: videoInfo.videoDetails.title,
        transcript: transcriptTextJoined,
        transcriptLanguageCode: lang,
        languages: availableLanguages.length > 0 ? availableLanguages : undefined
      });
    }

    // ------------------------------
    // No cached transcript → fetch video info and captions
    // ------------------------------
    const videoInfo = await safeGetVideoInfo(url);
    if (!videoInfo) {
      return res.status(403).json({ message: 'This is a private video. Cannot fetch transcript.' });
    }


    const duration = Math.floor(videoInfo.videoDetails.lengthSeconds / 60);
    const captionTracks = videoInfo.player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      return res.status(404).json({ message: 'No captions available for this video.' });
    }

    // Prepare available languages list (to be saved to Firestore)
    const availableLanguages = captionTracks.map(track => ({
      name: track.name.simpleText,
      code: track.languageCode
    }));

    // Load or initialize transcript array
    const existingData = doc.exists ? doc.data() : null;
    let transcriptArray = existingData ? existingData.transcript : [];

    let selectedTranscriptText = '';
    let selectedLanguageCode = '';

    // ------------------------------
    // Determine which language to fetch
    // ------------------------------
    if (lang) {
      const langTrack = captionTracks.find(track => track.languageCode === lang);
      if (!langTrack) {
        return res.status(404).json({ message: `No captions available in the requested language (${lang}).` });
      }

      selectedLanguageCode = lang;
      // lines is your array of { start, dur, text }
      const lines = await fetchTranscript(videoId, selectedLanguageCode);
      // build a single string
      selectedTranscriptText = lines.map(item => item.text).join(' ');

    } else {
      const preferredTrack = captionTracks.find(track => track.languageCode.startsWith('en') && track.kind !== 'asr')
        || captionTracks.find(track => track.languageCode.startsWith('en'))
        || captionTracks[0];

      selectedLanguageCode = preferredTrack.languageCode;
      // lines is your array of { start, dur, text }
      const lines = await fetchTranscript(videoId, selectedLanguageCode);
      // build a single string
      selectedTranscriptText = lines.map(item => item.text).join(' ');
    }

    // ------------------------------
    // Update transcript array (add or update)
    // ------------------------------
    const existingIndex = transcriptArray.findIndex(t => t.language === selectedLanguageCode);

    if (existingIndex !== -1) {
      // Update existing transcript
      transcriptArray[existingIndex] = {
        language: selectedLanguageCode,
        title: videoInfo.videoDetails.title,
        transcript: selectedTranscriptText
      };
    } else {
      // Add new transcript
      transcriptArray.push({
        language: selectedLanguageCode,
        title: videoInfo.videoDetails.title,
        transcript: selectedTranscriptText
      });
    }

    // ------------------------------
    // Save everything to Firestore
    // ------------------------------
    await docRef.set({
      videoID: videoId,
      duration: duration,
      transcript: transcriptArray,
      availableLanguages: availableLanguages,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Transcript saved to Firebase for ${videoId}`);

    // ------------------------------
    // Return response
    // ------------------------------
    res.json({
      videoID: videoId,
      duration: duration,
      title: videoInfo.videoDetails.title,
      transcript: selectedTranscriptText,
      transcriptLanguageCode: selectedLanguageCode,
      languages: availableLanguages.length > 0 ? availableLanguages : undefined,
      videoInfoSummary: {
        author: videoInfo.videoDetails.author,
        description: videoInfo.videoDetails.description,
        embed: videoInfo.videoDetails.embed,
        thumbnails: videoInfo.videoDetails.thumbnails,
        viewCount: videoInfo.videoDetails.viewCount,
        publishDate: videoInfo.videoDetails.publishDate,
        video_url: videoInfo.videoDetails.video_url,
      }
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'An error occurred while fetching and saving the transcript.' });
  }
});

/**
 * POST /smart-transcript
 * Fetches the transcript for a YouTube video, either from Firestore (if cached) or from YouTube (and stores it in Firestore).
 * 
 * Request Body:
 *   url (string): The URL of the YouTube video.
 * 
 * Response:
 *   200: JSON object with video details, duration, and transcript.
 *   404: No captions available for this video.
 *   500: Error fetching the transcript.
 */
app.post('/smart-transcript', async (req, res) => {
  try {
    const { url } = req.body;
    const videoId = ytdl.getURLVideoID(url);

    // Check if transcript already exists in Firestore
    const docRef = db.collection('transcripts').doc(videoId);
    const doc = await docRef.get();

    if (doc.exists) {
      console.log(`Transcript found in Firebase for ${videoId}`);
      return res.json(doc.data());
    }

    // Get video info and fetch captions
    const videoInfo = await ytdl.getBasicInfo(url);
    const duration = Math.floor(videoInfo.videoDetails.lengthSeconds / 60);  // Convert to minutes

    // Log the video info to check its structure
    console.log('Video Info:', videoInfo);

    // Ensure player_response and captions are available
    const playerResponse = videoInfo.player_response;
    if (!playerResponse || !playerResponse.captions || !playerResponse.captions.playerCaptionsTracklistRenderer) {
      return res.status(404).json({ message: 'No captions available for this video.' });
    }


    // Fetch available captions (subtitles)
    const captionTracks = videoInfo.player_response.captions.playerCaptionsTracklistRenderer.captionTracks;
    console.log('Caption Tracks:', captionTracks);

    if (!captionTracks || captionTracks.length === 0) {
      return res.status(404).json({ message: 'No captions available for this video.' });
    }

    // Select the first available caption track
    const languageCode = captionTracks[0].languageCode;

    // Fetch the transcript
    try {
      const transcript = await getSubtitles({ videoID: videoId, lang: languageCode });
      if (!transcript || transcript.length === 0) {
        throw new Error('No English captions available for this video.');
      }

      // Combine all transcript items into a single string
      const transcriptText = transcript.map(item => item.text).join(' ');

      // Store the transcript in Firestore
      await docRef.set({
        videoId,
        title: videoInfo.videoDetails.title,
        duration,
        transcript: transcriptText,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Full transcript stored in Firebase for ${videoId}`);

      // Return the transcript
      res.json({
        videoId,
        title: videoInfo.videoDetails.title,
        duration,
        transcript: transcriptText,
      });

    } catch (transcriptError) {
      console.error('Error fetching transcript:', transcriptError.message);
      res.status(404).json({ message: 'No transcript found for this video.' });
    }
  } catch (error) {
    console.error('Error fetching/storing transcript:', error);
    res.status(500).json({ message: 'An error occurred while processing the transcript.' });
  }
});

/**
 * @route POST /smart-transcript-v2
 * @description Fetches the transcript and basic metadata for a YouTube video and stores it in Firestore.
 * @param {Object} req.body - The request payload.
 * @param {string} req.body.url - The full YouTube video URL.
 * @returns {Object} 200 - Returns stored transcript and metadata (title, duration, date, tags, etc.).
 * @returns {Object} 404 - If no transcript is available for the video.
 * @returns {Object} 500 - If an internal error occurs during processing.
 *
 * @example
 * POST /smart-transcript-v2
 * {
 *   "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 * }
 */
app.post('/smart-transcript-v2', async (req, res) => {
  try {
    const { url } = req.body;
    const videoId = ytdl.getURLVideoID(url);

    const docRef = db.collection('transcripts').doc(videoId);
    const doc = await docRef.get();

    if (doc.exists) {
      console.log(`Transcript found in Firebase for ${videoId}`);
      return res.json(doc.data());
    }

    const videoInfo = await ytdl.getBasicInfo(url);
    const duration = Math.floor(videoInfo.videoDetails.lengthSeconds / 60);

    const playerResponse = videoInfo.player_response;
    if (!playerResponse || !playerResponse.captions || !playerResponse.captions.playerCaptionsTracklistRenderer) {
      return res.status(404).json({ message: 'No captions available for this video.' });
    }

    const captionTracks = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!captionTracks || captionTracks.length === 0) {
      return res.status(404).json({ message: 'No captions available for this video.' });
    }

    const languageCode = captionTracks[0].languageCode;

    try {
      // lines is your array of { start, dur, text }
      const lines = await fetchTranscript(videoId, languageCode);
      // build a single string
      const transcript = lines.map(item => item.text).join(' ');

      // Metadata to save
      const title = videoInfo.videoDetails.title;
      const description = videoInfo.videoDetails.description;
      const publishedAt = videoInfo.videoDetails.publishDate || new Date().toISOString().split('T')[0];
      const date = publishedAt;
      const image = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
      const tags = videoInfo.videoDetails.keywords || [];
      const canonical_url = `https://blog.andreszenteno.com/notes/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
      const video_author = videoInfo.videoDetails.author.name;
      const video_url = videoInfo.videoDetails.video_url;
      const category = videoInfo.videoDetails.category;
      const published_date = videoInfo.videoDetails.publishDate;

      // Save all metadata + transcript
      await docRef.set({
        videoId,
        video_author,
        video_url,
        category,
        published_date,
        title,
        description,
        duration,
        date,
        image,
        tags,
        canonical_url,
        author: video_author || 'Andres Zenteno',
        transcript,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Full transcript and metadata stored in Firebase for ${videoId}`);

      res.json({
        videoId,
        video_author,
        video_url,
        category,
        published_date,
        title,
        description,
        duration,
        date,
        image,
        tags,
        canonical_url,
        author: video_author || 'Andres Zenteno',
        transcript,
      });

    } catch (transcriptError) {
      console.error('Error fetching transcript:', transcriptError.message);
      res.status(404).json({ message: 'No transcript found for this video.' });
    }
  } catch (error) {
    console.error('Error fetching/storing transcript:', error);
    res.status(500).json({ message: 'An error occurred while processing the transcript.' });
  }
});


/**
 * POST /smart-summary
 * Fetches a smart summary for a YouTube video using the provided transcript.
 * The transcript can either be provided by the client or fetched from YouTube.
 * The summary is generated by an external model, such as ChatGPT, and is stored in Firestore.
 * 
 * Request Body:
 *   url (string): The URL of the YouTube video.
 *   transcript (string, optional): The transcript of the video. If not provided, it will be fetched from YouTube.
 *   model (string): The model to use for generating the summary. Possible values are `chatgpt`, `deepseek`, and `anthropic`.
 * 
 * Response:
 *   200: JSON object with the generated summary.
 *   400: Invalid URL or model specified.
 *   404: Video not found or no captions available.
 *   500: Error generating the smart summary.
 */

// Model URL mapping
const modelUrls = {
  chatgpt: process.env.CHATGPT_VERCEL_URL,
  deepseek: process.env.DEEPSEEK_VERCEL_URL,
  anthropic: process.env.ANTHROPIC_VERCEL_URL,
};

app.post('/smart-summary', async (req, res) => {
  try {
    const { url, transcript, model } = req.body;
    if (!url) return res.status(400).json({ message: 'URL is required' });
    console.log('URL:', url, ', Model:', model);

    const videoId = ytdl.getURLVideoID(url);

    // Initialize Firestore if not already
    const db = admin.firestore();
    const docRef = db.collection('summaries').doc(videoId);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      console.log(`Summary found in Firebase for ${videoId}`);
      const data = docSnap.data();
      if (data.summary) {
        return res.json({ summary: data.summary, fromCache: true });
      }
    }

    // Use provided transcript or fetch it from YouTube if missing
    let rawTranscript = transcript;

    if (!rawTranscript) {
      const fetchedTranscript = await getSubtitles({
        videoID: videoId,
        lang: 'en',
      });
      rawTranscript = fetchedTranscript.map((item) => item.text).join(' ');
    }

    // Prepare request to the selected model
    // Prepare ChatGPT request
    const systemMessage = {
      role: 'system',
      content: `# IDENTITY and PURPOSE
    As an organized, high-skill content summarizer, your role is to extract the most relevant topics from a video transcript and provide a structured summary using bullet points and lists of definitions for each subject.
    Your goal is to help the user understand the content quickly and efficiently.
    You take content in and output a Markdown formatted summary using the format below.
    Take a deep breath and think step by step about how to best accomplish this goal using the following steps.

    # OUTPUT SECTIONS
    - Combine all of your understanding of the content into a single, 20-word sentence in a section called ## One Sentence Summary:.
    - Output the 10 most important points of the content as a list with no more than 16 words per point into a section called ## Main Points:.
    - Output a list of the 5 best takeaways from the content in a section called ## Takeaways:.

    # OUTPUT INSTRUCTIONS
    - You only output human readable Markdown.
    - Use a simple and clear language
    - Create the output using the formatting above.
    - Output numbered lists, not bullets.
    - Use ## for section headers.
    - Use ### for sub-section headers.
    - Use **bold** for important terms.
    - Use *italics* for emphasis.
    - Use [links](https://example.com) for references.
    - Do not output warnings or notes—just the requested sections.
    - Do not repeat items in the output sections.
    - Do not start items with the same opening words.
    - To ensure the summary is easily searchable in the future, keep the structure clear and straightforward.
    # INPUT:
    INPUT:
    `};
    const userMessage = {
      role: 'user',
      content: `${rawTranscript}`
    };
    const chatGptMessages = [systemMessage, userMessage];

    // Check if the model is valid and exists in the mapping
    const modelUrl = modelUrls[model];
    if (!modelUrl) {
      return res.status(400).json({ message: 'Invalid model specified' });
    }

    const openaiResponse = await axios.post(
      modelUrl,
      { chatGptMessages },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000, // Timeout in milliseconds (e.g., 120 seconds)
      }
    );

    const summary = openaiResponse.data.choices?.[0]?.message?.content;

    if (summary) {
      console.log(`Summary stored in Firebase for ${videoId}`);
      await docRef.set(
        {
          summary,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    res.json({ summary, fromCache: false });
  } catch (err) {
    console.error('Error in /smart-summary:', err);
    res.status(500).json({ message: 'Error generating smart summary' });
  }
});

/**
 * POST /smart-summary-firebase
 * Fetches a smart summary for a YouTube video by first checking Firestore for an existing summary.
 * If a summary is not found in Firestore, the transcript is fetched and summarized by an external model, and the result is stored in Firestore.
 * 
 * Request Body:
 *   url (string): The URL of the YouTube video.
 *   model (string): The model to use for generating the summary. Possible values are `chatgpt`, `deepseek`, and `anthropic`.
 * 
 * Response:
 *   200: JSON object with the generated summary.
 *   400: Invalid URL or model specified.
 *   404: Video not found or no captions available.
 *   500: Error generating the smart summary.
 */
app.post('/smart-summary-firebase', async (req, res) => {
  try {
    const { url, model } = req.body;
    if (!url) return res.status(400).json({ message: 'URL is required' });
    console.log('URL:', url, ', Model:', model);

    const videoId = ytdl.getURLVideoID(url);

    // Initialize Firestore if not already
    const db = admin.firestore();
    const docRef = db.collection('summaries').doc(videoId);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      console.log(`Summary found in Firebase for ${videoId}`);
      const data = docSnap.data();
      if (data.summary) {
        return res.json({ summary: data.summary, fromCache: true });
      }
    }

    // Send only the video ID to the Vercel endpoint to fetch the transcript from Firestore and summarize it
    const modelUrl = modelUrls[model];
    console.log('Model URL:', modelUrl);
    if (!modelUrl) {
      return res.status(400).json({ message: 'Invalid model specified' });
    }

    const response = await axios.post(modelUrl, {
      videoId  // Only send the video ID
    });
    console.log('Response from model:', response.data);

    const summary = model === 'anthropic' ? response.data.content?.[0]?.text : response.data.choices?.[0]?.message?.content;

    if (summary) {
      console.log(`Summary stored in Firebase for ${videoId}`);
      await docRef.set(
        {
          summary,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    res.json({ summary, fromCache: false });
  } catch (err) {
    console.error('Error in /smart-summary-firebase:', err);
    res.status(500).json({ message: 'Error generating smart summary' });
  }
});

/**
 * @route POST /smart-summary-firebase-v2
 * @description Generates an AI-powered summary and tags for a YouTube video's transcript.
 *              Uses existing transcript metadata from Firestore and enriches it with AI-generated content.
 *              Stores the result (with YAML frontmatter) in the `summaries` collection and updates tags in `transcripts`.
 * @param {Object} req.body - The request payload.
 * @param {string} req.body.url - The full YouTube video URL.
 * @param {string} req.body.model - The model key used to route to the correct OpenAI/Vercel endpoint.
 * @returns {Object} 200 - Returns the formatted markdown summary with frontmatter.
 * @returns {Object} 400 - If URL or model is missing or invalid.
 * @returns {Object} 404 - If transcript data is missing.
 * @returns {Object} 500 - If the model fails or an internal error occurs.
 *
 * @example
 * POST /smart-summary-firebase-v2
 * {
 *   "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
 *   "model": "openai"
 * }
 */
app.post('/smart-summary-firebase-v2', async (req, res) => {
  try {
    const { url, model } = req.body;
    if (!url) return res.status(400).json({ message: 'URL is required' });

    const videoId = ytdl.getURLVideoID(url);
    const db = admin.firestore();
    const summariesRef = db.collection('summaries').doc(videoId);
    const transcriptRef = db.collection('transcripts').doc(videoId);

    // Check if summary already exists
    const summarySnap = await summariesRef.get();
    if (summarySnap.exists) {
      const data = summarySnap.data();
      if (data.summary) {
        console.log(`Summary found in Firebase for ${videoId}`);
        return res.json({ summary: data.summary, fromCache: true });
      }
    }

    // Get metadata from transcript doc
    const transcriptSnap = await transcriptRef.get();
    if (!transcriptSnap.exists) {
      return res.status(404).json({ message: 'Transcript not found for this video.' });
    }

    const metadata = transcriptSnap.data();

    // Ensure model is valid
    const modelUrl = modelUrls[model];
    if (!modelUrl) {
      return res.status(400).json({ message: 'Invalid model specified' });
    }

    // 🧠 Call your deployed endpoint that returns both summary and tags
    const response = await axios.post(modelUrl, {
      videoId,
    });

    const plainSummary = response.data.summary?.choices?.[0]?.message?.content;
    const tags = response.data.tags || [];

    if (!plainSummary) {
      return res.status(500).json({ message: 'Model did not return a summary' });
    }

    // 📝 Construct frontmatter
    const frontmatter = `---
title: "${metadata.title}"
date: ${metadata.date}
description: |
  ${metadata.description}
image: '${metadata.image}'
tags:
${tags.map(tag => `  - ${tag}`).join('\n')}
canonical_url: ${metadata.canonical_url}
author: ${metadata.author}
---
![](https://www.youtube.com/watch?v=${videoId})
# ${metadata.title}\n`;

    const summaryWithFrontmatter = `${frontmatter}${plainSummary}`;

    // Save the summary to summaries collection
    await summariesRef.set(
      {
        summary: summaryWithFrontmatter,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        tags,
      },
      { merge: true }
    );

    // ✅ Update the tags in transcripts collection as well
    await transcriptRef.set(
      {
        tags,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );


    res.json({ summary: summaryWithFrontmatter, fromCache: false });

  } catch (err) {
    console.error('Error in /smart-summary-firebase-v2:', err);
    res.status(500).json({ message: 'Error generating smart summary' });
  }
});

/**
 * @route POST /smart-summary-firebase-v3
 * @description
 * Handles summarization of a YouTube video's transcript using an external AI model.
 * - Checks Firebase Firestore for a cached summary.
 * - If not found, retrieves transcript metadata.
 * - Sends a request to a model endpoint to generate the summary.
 * - Constructs a full Markdown document with YAML frontmatter.
 * - Saves the summary to the `summaries` Firestore collection.
 * 
 * @param {Object} req - Express request object.
 * @param {Object} req.body - Request body.
 * @param {string} req.body.url - Full YouTube video URL. Required.
 * @param {string} req.body.model - Model name to use for summarization (e.g., "chatgpt", "anthropic"). Required.
 * 
 * @param {Object} res - Express response object.
 * 
 * @returns {Object} 200 - Success response with the generated summary:
 * {
 *   summary: string,        // Markdown content including YAML frontmatter
 *   fromCache: boolean      // True if returned from Firebase cache, false if generated
 * }
 * 
 * @returns {Object} 400 - If URL or model is missing or invalid:
 * {
 *   message: string
 * }
 * 
 * @returns {Object} 404 - If no transcript was found for the given video:
 * {
 *   message: 'Transcript not found for this video.'
 * }
 * 
 * @returns {Object} 500 - On internal errors or failed model response:
 * {
 *   message: string
 * }
 */

app.post('/smart-summary-firebase-v3', async (req, res) => {
  try {
    const { url, model } = req.body;
    if (!url) return res.status(400).json({ message: 'URL is required' });

    const videoId = ytdl.getURLVideoID(url);
    const db = admin.firestore();
    const summariesRef = db.collection('summaries').doc(videoId);
    const transcriptRef = db.collection('transcripts').doc(videoId);

    // Check if summary already exists
    const summarySnap = await summariesRef.get();
    if (summarySnap.exists) {
      const data = summarySnap.data();
      if (data.summary) {
        console.log(`Summary found in Firebase for ${videoId}`);
        return res.json({ summary: data.summary, fromCache: true });
      }
    }

    // Get metadata from transcript doc
    const transcriptSnap = await transcriptRef.get();
    if (!transcriptSnap.exists) {
      return res.status(404).json({ message: 'Transcript not found for this video.' });
    }

    const metadata = transcriptSnap.data();

    // Ensure model is valid
    const modelUrl = modelUrls[model];
    if (!modelUrl) {
      return res.status(400).json({ message: 'Invalid model specified' });
    }

    // 🧠 Call your deployed endpoint that returns the summary
    const response = await axios.post(modelUrl, {
      videoId,
    });
    console.log('Response from model:', response.data);

    const summary = model === 'anthropic' ? response.data.content?.[0]?.text : response.data.choices?.[0]?.message?.content;

    if (!summary) {
      return res.status(500).json({ message: 'Model did not return a summary' });
    }
    const rawDescription = metadata.description;
    const yamlSafeDescription = '|\n' + rawDescription
      .replace(/\r\n/g, '\n') // Normalize Windows newlines
      .split('\n')
      .map(line => `  ${line}`) // indent all lines exactly 2 spaces
      .join('\n');

    // Construct frontmatter
    const frontmatter = `---
title: "${metadata.title}"
date: ${metadata.date}
category: ${metadata.category}
description: ${yamlSafeDescription}
image: '${metadata.image}'
duration: ${metadata.duration}
tags: 
${metadata.tags.map(tag => `  - ${tag}`).join('\n')}
canonical_url: ${metadata.canonical_url}
author: ${metadata.author}
video_author: ${metadata.video_author}
video_url: ${metadata.video_url}
video_id: ${videoId}
published_date: ${metadata.published_date}
---
![](https://www.youtube.com/watch?v=${videoId})
# ${metadata.title}\n`;

    const summaryWithFrontmatter = `${frontmatter}${summary}`;

    // Save the summary to summaries collection
    console.log(`Summary stored in Firebase for ${videoId}`);
    await summariesRef.set(
      {
        summary: summaryWithFrontmatter,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        tags: metadata.tags,
      },
      { merge: true }
    );

    res.json({ summary: summaryWithFrontmatter, fromCache: false });

  } catch (err) {
    console.error('Error in /smart-summary-firebase-v3:', err);
    res.status(500).json({ message: 'Error generating smart summary' });
  }
});


const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on port ${port}`);
  logger.info(`Server is running on port ${port}`);
  console.log('Server started at:', new Date().toISOString());
  logger.info('Server started at:', new Date().toISOString());
});
