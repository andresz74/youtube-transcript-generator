require('dotenv').config();

const axios = require('axios');
const cors = require('cors');
const express = require('express');
const he = require('he');
const getSubtitles = require('youtube-captions-scraper').getSubtitles;
const ytdl = require('ytdl-core');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const fabricFetchTranscript = require('./fabric-youtube').fabricFetchTranscript;
const fetchTranscript = require('./youtube').fetchTranscript;

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

/**
 * GET /health/tools
 * Verifies tool availability and basic runtime context.
 */
function runCommand(command, args = []) {
  return new Promise((resolve) => {
    execFile(command, args, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        error: error ? (stderr || error.message) : null,
        output: (stdout || stderr || '').trim(),
      });
    });
  });
}

app.get('/health/tools', async (req, res) => {
  const cookiePath = path.resolve(__dirname, 'all_cookies.txt');
  let cookiesReadable = false;
  try {
    fs.accessSync(cookiePath, fs.constants.R_OK);
    cookiesReadable = true;
  } catch (_) {
    cookiesReadable = false;
  }

  const ytDlp = await runCommand('yt-dlp', ['--version']);
  const deno = await runCommand('deno', ['--version']);

  res.json({
    path: process.env.PATH,
    ytDlp,
    deno,
    cookies: {
      path: cookiePath,
      readable: cookiesReadable,
    }
  });
});

/**
 * GET /api/transcript
 * Fetches captions for a YouTube video using the internal transcript fetcher.
 *
 * Query:
 *   videoId (string): The YouTube video ID (required).
 *   lang (string): Optional language code (default: "en").
 */
app.get('/api/transcript', async (req, res) => {
  try {
    const { videoId, lang = 'en' } = req.query;
    if (!videoId) {
      return res.status(400).json({ error: 'videoId required' });
    }

    const lines = await fetchTranscript(videoId, lang);
    if (!lines || lines.length === 0) {
      return res.status(404).json({ error: 'No captions found' });
    }

    res.json({
      videoId,
      lang,
      captions: lines.map(line => ({
        start: line.start,
        duration: line.dur,
        text: line.text,
      })),
    });
  } catch (err) {
    const message = err.message || 'Failed to fetch transcript';
    const status = err.response?.status;
    if (status === 401 || /missing app check token/i.test(message)) {
      return res.status(404).json({
        error: 'No captions found',
        details: 'Legacy transcript fallback returned 401 (Missing App Check token).'
      });
    }
    if (/no captiontracks|captions|transcript/i.test(message)) {
      return res.status(404).json({ error: message });
    }
    console.error('Error in /api/transcript:', err);
    res.status(500).json({ error: 'Failed to fetch transcript' });
  }
});

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
    const videoID = ytdl.getURLVideoID(url);
    if (!videoID) {
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
    // lines is your array of { start, dur, text }
    const lines = await fetchTranscript(videoID, languageCode);

    // Prepare the response in the desired format
    const response = {
      status: 'success',
      status_code: 200,
      code: 100000,
      message: 'success',
      data: {
        videoID: videoID,
        videoInfo: videoInfo,
        videoInfoSummary: {
          name: videoInfo.videoDetails.title,
          thumbnailUrl: {
            hqdefault: videoInfo.videoDetails.thumbnails[0].url,
          },
          embedUrl: `https://www.youtube.com/embed/${videoID}`,
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
            custom: lines.map((item) => ({
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
    const videoID = ytdl.getURLVideoID(url);

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
    const transcriptText = await fabricFetchTranscript(videoID, languageCode);

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

/**
 * POST /simple-transcript-v2
 * Fetches and returns the video metadata and concatenated transcript, prioritizing English transcripts
 * when available (or a requested language if specified). Includes comprehensive video information.
 * 
 * Request Body:
 *   url (string): The URL of the YouTube video (required).
 *   lang (string, optional): The preferred language code for the transcript (e.g., "en", "es", "fr-CA").
 * 
 * Response:
 *   200: JSON object containing:
 *     - duration (number): Video duration in minutes.
 *     - title (string): Video title.
 *     - transcript (string): Concatenated transcript text.
 *     - transcriptLanguageCode (string): Language code of returned transcript.
 *     - languages (array, optional): Available caption languages (format: {name: string, code: string}).
 *     - videoInfoSummary (object): Detailed video metadata including:
 *       - author (string): Channel/uploader name.
 *       - description (string): Video description.
 *       - embed (object): Embeddable player info.
 *       - thumbnails (array): Video thumbnail URLs in various resolutions.
 *       - viewCount (string): Formatted view count.
 *       - publishDate (string): ISO 8601 publish date.
 *       - video_url (string): Canonical video URL.
 * 
 *   404: JSON object with error message when:
 *     - No captions exist for the video.
 *     - Requested language is unavailable.
 * 
 *   500: JSON object with error message when:
 *     - URL parsing fails.
 *     - YouTube API request fails.
 *     - Transcript processing fails.
 * 
 * Notes:
 *   - Auto-detects YouTube Shorts format.
 *   - Prioritizes non-auto-generated English captions when no language specified.
 *   - Falls back to first available language if preferred language unavailable.
 */
app.post('/simple-transcript-v2', async (req, res) => {
  try {
    const { url, lang } = req.body;
    console.log('URL:', url, ', Language:', lang);
    // Check if the video is a YouTube Short (specific format for Shorts videos)
    const isShort = url.includes('/shorts/');
    console.log('isShort:', isShort);

    // Extract video ID from URL
    const videoID = ytdl.getURLVideoID(url);

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
        const lines = await fetchTranscript(videoID, languageCode);
        if (!lines || lines.length === 0) {
          throw new Error(`No captions available in the requested language (${lang}).`);
        }
        // Combine all lines items into a single string
        const transcriptText = lines.map(item => item.text).join(' ');
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
        videoID: videoID,
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
        videoID: videoID,
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
  console.log('===> safeGetVideoInfo');
  try {
    console.log('===> safeGetVideoInfo try');
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

    const videoID = ytdl.getURLVideoID(url);
    console.log('===> videoID:', videoID);
    const docRef = db.collection('transcripts-multilingual').doc(videoID);
    const doc = await docRef.get();

    // ------------------------------
    // If cached transcript exists → use it
    // ------------------------------
    if (doc.exists) {
      console.log(`Transcript found in Firebase for ${videoID}`);
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

      // const transcriptText = await getSubtitles({ videoID: videoID, lang });
      // lines is your array of { start, dur, text }
      const transcript = await fabricFetchTranscript(videoID, lang);

      // Update transcript array
      const transcriptArray = cached.transcript;
      transcriptArray.push({
        language: lang,
        title: videoInfo.videoDetails.title,
        transcript: transcript
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
        transcript: transcript,
        transcriptLanguageCode: lang,
        languages: availableLanguages.length > 0 ? availableLanguages : undefined
      });
    }

    // ------------------------------
    // No cached transcript → fetch video info and captions
    // ------------------------------
    const videoInfo = await safeGetVideoInfo(url);
    console.log('===> videoInfo:', videoInfo);
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

    let transcriptText = '';
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
      transcriptText = await fabricFetchTranscript(videoID, selectedLanguageCode);

    } else {
      const preferredTrack = captionTracks.find(track => track.languageCode.startsWith('en') && track.kind !== 'asr')
        || captionTracks.find(track => track.languageCode.startsWith('en'))
        || captionTracks[0];

      selectedLanguageCode = preferredTrack.languageCode;
      transcriptText = await fabricFetchTranscript(videoID, selectedLanguageCode);
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
        transcript: transcriptText
      };
    } else {
      // Add new transcript
      transcriptArray.push({
        language: selectedLanguageCode,
        title: videoInfo.videoDetails.title,
        transcript: transcriptText
      });
    }

    // ------------------------------
    // Save everything to Firestore
    // ------------------------------
    await docRef.set({
      videoID: videoID,
      duration: duration,
      transcript: transcriptArray,
      availableLanguages: availableLanguages,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Transcript saved to Firebase for ${videoID}`);

    // ------------------------------
    // Return response
    // ------------------------------
    res.json({
      videoID: videoID,
      duration: duration,
      title: videoInfo.videoDetails.title,
      transcript: transcriptText,
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
    const videoID = ytdl.getURLVideoID(url);

    // Check if transcript already exists in Firestore
    const docRef = db.collection('transcripts').doc(videoID);
    const doc = await docRef.get();

    if (doc.exists) {
      console.log(`Transcript found in Firebase for ${videoID}`);
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
      const transcript = await getSubtitles({ videoID: videoID, lang: languageCode });
      if (!transcript || transcript.length === 0) {
        throw new Error('No English captions available for this video.');
      }

      // Combine all transcript items into a single string
      const transcriptText = transcript.map(item => item.text).join(' ');

      // Store the transcript in Firestore
      await docRef.set({
        videoID,
        title: videoInfo.videoDetails.title,
        duration,
        transcript: transcriptText,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Full transcript stored in Firebase for ${videoID}`);

      // Return the transcript
      res.json({
        videoID,
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
    if (!url) {
      return res.status(400).json({ message: 'URL is required' });
    }
    let videoID;
    try {
      videoID = ytdl.getURLVideoID(url);
    } catch (err) {
      return res.status(400).json({ message: 'Invalid YouTube URL' });
    }
    console.log('>>> videoID', videoID);

    const docRef = db.collection('transcripts').doc(videoID);
    const doc = await docRef.get();
    if (doc.exists) {
      console.log(`Transcript found in Firebase for ${videoID}`);
      const cached = doc.data();
      if (cached?.transcript) {
        return res.json(cached);
      }
    }

    const videoInfo = await ytdl.getBasicInfo(url);
    const duration = Math.floor(videoInfo.videoDetails.lengthSeconds / 60);
    const playerResponse = videoInfo.player_response;

    const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (captionTracks.length === 0) {
      return res.status(404).json({ message: 'No captions available for this video.' });
    }
    const preferredTrack = captionTracks.find(track => track.languageCode?.startsWith('en') && track.kind !== 'asr')
      || captionTracks.find(track => track.languageCode?.startsWith('en'))
      || captionTracks[0];
    const languageCode = preferredTrack?.languageCode;

    debugLog(TRANSCRIPT_DEBUG, 'Transcript fetch candidates:', captionTracks.map(track => ({
      code: track.languageCode,
      name: track.name?.simpleText,
      kind: track.kind || 'manual',
    })));
    debugLog(TRANSCRIPT_DEBUG, 'Selected transcript languageCode:', languageCode);

    let transcript = '';
    try {
      if (languageCode) {
        try {
          debugLog(TRANSCRIPT_DEBUG, 'Attempting fabricFetchTranscript...');
          transcript = await fabricFetchTranscript(videoID, languageCode);
          debugLog(TRANSCRIPT_DEBUG, 'fabricFetchTranscript result length:', transcript ? transcript.length : 0);
        } catch (fabricError) {
          console.warn('fabricFetchTranscript failed:', fabricError.message);
          console.warn(fabricError.stack || fabricError);
        }
        if (!transcript) {
          try {
            debugLog(TRANSCRIPT_DEBUG, 'Attempting getSubtitles fallback...');
            const fallback = await getSubtitles({ videoID, lang: languageCode });
            debugLog(TRANSCRIPT_DEBUG, 'getSubtitles result items:', fallback ? fallback.length : 0);
            if (!fallback || fallback.length === 0) {
              throw new Error('getSubtitles returned empty result');
            }
            transcript = fallback.map(item => item.text).join(' ');
          } catch (subtitlesError) {
            console.warn('getSubtitles failed:', subtitlesError.message);
            console.warn(subtitlesError.stack || subtitlesError);
          }
        }
      } else {
        console.warn('No caption language available.');
      }
    } catch (transcriptError) {
      try {
        debugLog(TRANSCRIPT_DEBUG, 'Attempting getSubtitles fallback after error...');
        const fallback = await getSubtitles({ videoID, lang: languageCode });
        debugLog(TRANSCRIPT_DEBUG, 'getSubtitles result items:', fallback ? fallback.length : 0);
        if (!fallback || fallback.length === 0) {
          throw new Error('getSubtitles returned empty result');
        }
        transcript = fallback.map(item => item.text).join(' ');
      } catch (fallbackError) {
        console.warn('Transcript fetch failed:', transcriptError.message);
        console.warn('Transcript fallback failed:', fallbackError.message);
        console.warn(transcriptError.stack || transcriptError);
        console.warn(fallbackError.stack || fallbackError);
      }
    }

    if (!transcript) {
      try {
        debugLog(TRANSCRIPT_DEBUG, 'Attempting fetchTranscript scrape fallback...');
        const lines = await fetchTranscript(videoID, languageCode || 'en');
        debugLog(TRANSCRIPT_DEBUG, 'fetchTranscript result items:', lines ? lines.length : 0);
        transcript = lines.map(item => item.text).join(' ');
      } catch (scrapeError) {
        console.warn('Transcript scrape failed:', scrapeError.message);
        console.warn(scrapeError.stack || scrapeError);
      }
    }

    // Metadata to save
    const title = videoInfo.videoDetails.title;
    const description = videoInfo.videoDetails.description;
    const publishedAt = videoInfo.videoDetails.publishDate || new Date().toISOString().split('T')[0];
    const image = `https://i.ytimg.com/vi/${videoID}/maxresdefault.jpg`;
    const tags = videoInfo.videoDetails.keywords || [];
    const slugBase = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = slugBase.slice(0, 80) || videoID;
    const canonical_url = `https://blog.andreszenteno.com/notes/${slug}`;
    const video_author = videoInfo.videoDetails.author.name;
    const video_url = videoInfo.videoDetails.video_url;
    const category = videoInfo.videoDetails.category;
    const published_date = videoInfo.videoDetails.publishDate;

    // Save to Firestore
    await docRef.set({
      videoID,
      video_author,
      video_url,
      category,
      published_date,
      title,
      description,
      duration,
      date: publishedAt,
      image,
      tags,
      canonical_url,
      author: video_author || 'Andres Zenteno',
      transcript,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Metadata${transcript ? ' + transcript' : ''} stored in Firebase for ${videoID}`);

    const responsePayload = {
      videoID,
      video_author,
      video_url,
      category,
      published_date,
      title,
      description,
      duration,
      date: publishedAt,
      image,
      tags,
      canonical_url,
      author: video_author || 'Andres Zenteno',
      transcript,
    };

    if (!transcript) {
      responsePayload.warning = 'No transcript found, but metadata saved.';
    }
    res.json(responsePayload);

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

const MODEL_TIMEOUT_MS = 120000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const TRANSCRIPT_DEBUG = process.env.TRANSCRIPT_DEBUG === 'true';
const SUMMARY_DEBUG = process.env.SUMMARY_DEBUG === 'true';
const MODEL_API_ACCESS_KEY = process.env.API_ACCESS_KEY;

if (!MODEL_API_ACCESS_KEY) {
  console.warn('API_ACCESS_KEY is not set. Requests to protected model APIs may fail with 401.');
}

function debugLog(enabled, ...args) {
  if (enabled) {
    console.log(...args);
  }
}

function buildModelRequestHeaders(headers = {}) {
  const mergedHeaders = {
    'Content-Type': 'application/json',
    ...headers,
  };

  if (MODEL_API_ACCESS_KEY) {
    mergedHeaders['X-API-Key'] = MODEL_API_ACCESS_KEY;
    if (!mergedHeaders.Authorization && !mergedHeaders.authorization) {
      mergedHeaders.Authorization = `Bearer ${MODEL_API_ACCESS_KEY}`;
    }
  }

  return mergedHeaders;
}

function buildTagsFromText(text) {
  const stopwords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are',
    'was', 'were', 'has', 'have', 'had', 'not', 'but', 'its', 'into', 'their',
    'they', 'them', 'then', 'than', 'also', 'over', 'more', 'less', 'very',
    'been', 'being', 'when', 'where', 'what', 'which', 'who', 'why', 'how',
    'can', 'could', 'will', 'would', 'should', 'about', 'after', 'before',
    'because', 'there', 'here', 'these', 'those', 'just', 'like', 'make',
    'made', 'most', 'such', 'some', 'only', 'much', 'many', 'yourself',
  ]);

  const counts = new Map();
  const words = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 4 && !stopwords.has(word));

  for (const word of words) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

async function postWithRetry(url, payload, options = {}) {
  const maxAttempts = options.maxAttempts || 3;
  const baseDelayMs = options.baseDelayMs || 500;
  const axiosOptions = options.axiosOptions || {};
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await axios.post(url, payload, {
        timeout: MODEL_TIMEOUT_MS,
        ...axiosOptions,
        headers: buildModelRequestHeaders(axiosOptions.headers),
      });
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      if (!status || !RETRYABLE_STATUS_CODES.has(status) || attempt === maxAttempts) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

app.post('/smart-summary', async (req, res) => {
  try {
    const { url, transcript, model } = req.body;
    if (!url) return res.status(400).json({ message: 'URL is required' });
    console.log('URL:', url, ', Model:', model);

    const videoID = ytdl.getURLVideoID(url);

    // Initialize Firestore if not already
    const db = admin.firestore();
    const docRef = db.collection('summaries').doc(videoID);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      console.log(`Summary found in Firebase for ${videoID}`);
      const data = docSnap.data();
      if (data.summary) {
        return res.json({ summary: data.summary, fromCache: true });
      }
    }

    // Use provided transcript or fetch it from YouTube if missing
    let rawTranscript = transcript;

    if (!rawTranscript) {
      const fetchedTranscript = await getSubtitles({
        videoID: videoID,
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
        headers: buildModelRequestHeaders(),
        timeout: 120000, // Timeout in milliseconds (e.g., 120 seconds)
      }
    );

    const summary = openaiResponse.data.choices?.[0]?.message?.content;

    if (summary) {
      console.log(`Summary stored in Firebase for ${videoID}`);
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

    const videoID = ytdl.getURLVideoID(url);

    // Initialize Firestore if not already
    const db = admin.firestore();
    const docRef = db.collection('summaries').doc(videoID);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      console.log(`Summary found in Firebase for ${videoID}`);
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

    const response = await axios.post(
      modelUrl,
      {
        videoID, // Only send the video ID
      },
      {
        headers: buildModelRequestHeaders(),
        timeout: MODEL_TIMEOUT_MS,
      }
    );
    debugLog(SUMMARY_DEBUG, 'Response from model:', response.data);

    const summary = model === 'anthropic' ? response.data.content?.[0]?.text : response.data.choices?.[0]?.message?.content;

    if (summary) {
      console.log(`Summary stored in Firebase for ${videoID}`);
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

    const videoID = ytdl.getURLVideoID(url);
    const db = admin.firestore();
    const summariesRef = db.collection('summaries').doc(videoID);
    const transcriptRef = db.collection('transcripts').doc(videoID);

    // Check if summary already exists
    const summarySnap = await summariesRef.get();
    if (summarySnap.exists) {
      const data = summarySnap.data();
      if (data.summary) {
        console.log(`Summary found in Firebase for ${videoID}`);
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
    const response = await axios.post(
      modelUrl,
      {
        videoID,
      },
      {
        headers: buildModelRequestHeaders(),
        timeout: MODEL_TIMEOUT_MS,
      }
    );

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
![](https://www.youtube.com/watch?v=${videoID})
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
    if (!model) return res.status(400).json({ message: 'Model is required' });

    let videoID;
    try {
      videoID = ytdl.getURLVideoID(url);
    } catch (err) {
      return res.status(400).json({ message: 'Invalid YouTube URL' });
    }
    console.log('>>> videoID', videoID);
    const db = admin.firestore();
    const summariesRef = db.collection('summaries').doc(videoID);
    const transcriptRef = db.collection('transcripts').doc(videoID);

    // Check if summary already exists
    const summarySnap = await summariesRef.get();
    if (summarySnap.exists) {
      const data = summarySnap.data();
      if (data.summary) {
        console.log(`Summary found in Firebase for ${videoID}`);
        return res.json({ summary: data.summary, fromCache: true });
      }
    }

    // Get metadata from transcript doc
    const transcriptSnap = await transcriptRef.get();
    if (!transcriptSnap.exists) {
      return res.status(404).json({ message: 'Transcript not found for this video.' });
    }

    const metadata = transcriptSnap.data();
    let tags = Array.isArray(metadata.tags) ? metadata.tags : [];

    // Ensure model is valid
    const modelUrl = modelUrls[model];
    if (!modelUrl) {
      return res.status(400).json({ message: 'Invalid model specified' });
    }

    // 🧠 Call your deployed endpoint that returns the summary
    let response;
    try {
      response = await postWithRetry(modelUrl, { videoID }, { maxAttempts: 3, baseDelayMs: 750 });
    } catch (err) {
      const status = err.response?.status || 502;
      const details = err.response?.data || err.message;
      console.error('Model request failed:', status, details);
      return res.status(502).json({ message: 'Model request failed', status, details });
    }
    debugLog(SUMMARY_DEBUG, 'Response from model:', response.data);

    const summary = model === 'anthropic'
      ? response.data.content?.[0]?.text
      : response.data.summaryText || response.data.text;

    if (!summary) {
      return res.status(500).json({ message: 'Model did not return a summary' });
    }
    if (tags.length === 0) {
      const tagSource = [metadata.title, metadata.description, summary].filter(Boolean).join(' ');
      tags = buildTagsFromText(tagSource);
    }

    const rawDescription = metadata.description || '';
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
${tags.map(tag => `  - ${tag}`).join('\n')}
canonical_url: ${metadata.canonical_url}
author: ${metadata.author}
video_author: ${metadata.video_author}
video_url: ${metadata.video_url}
video_id: ${videoID}
published_date: ${metadata.published_date}
---
![](https://www.youtube.com/watch?v=${videoID})
# ${metadata.title}\n`;

    const summaryWithFrontmatter = `${frontmatter}${summary}`;

    // Save the summary to summaries collection
    console.log(`Summary stored in Firebase for ${videoID}`);
    await summariesRef.set(
      {
        summary: summaryWithFrontmatter,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        tags,
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
