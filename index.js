require('dotenv').config();

const axios = require('axios');
const express = require('express');
const cors = require('cors');
const logger = require('./logger');
const ytdl = require('ytdl-core');
const getSubtitles = require('youtube-captions-scraper').getSubtitles;

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
  // Log every request with relevant details for debugging and monitoring
  logger.info(`Endpoint Hit: ${req.method} ${req.originalUrl} - ${new Date().toISOString()}`);
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
          return res.status(404).json({ message: 'Video not found' });
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

// Define other endpoints (like `/smart-summary`, `/smart-summary-firebase`, etc.) following a similar pattern...

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on port ${port}`);
    logger.info(`Server is running on port ${port}`);
    console.log('Server started at:', new Date().toISOString());
    logger.info('Server started at:', new Date().toISOString());
});
