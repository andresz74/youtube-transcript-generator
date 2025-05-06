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


app.post('/simple-transcript-v3', async (req, res) => {
  try {
    const { url, lang } = req.body;
    console.log('URL:', url, ', Language:', lang);

    const isShort = url.includes('/shorts/');
    console.log('isShort:', isShort);

    const videoId = ytdl.getURLVideoID(url);
    const docRef = db.collection('transcripts-multilingual').doc(videoId);
    const doc = await docRef.get();

    // If cached version exists, return immediately
    if (doc.exists) {
      console.log(`Transcript found in Firebase for ${videoId}`);

      const cached = doc.data();
      const cachedTranscript = cached.transcript.find(t => t.language === lang) || cached.transcript[0];

      return res.json({
        videoID: cached.videoID,
        duration: cached.duration,
        transcript: cachedTranscript.transcript,
        transcriptLanguageCode: cachedTranscript.language,
        languages: cached.transcript.length > 1 
          ? cached.transcript.map(t => ({ code: t.language })) 
          : undefined
      });
    }

    // Get video info
    const videoInfo = await ytdl.getBasicInfo(url);
    const duration = Math.floor(videoInfo.videoDetails.lengthSeconds / 60);

    const captionTracks = videoInfo.player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      return res.status(404).json({ message: 'No captions available for this video.' });
    }

    const languages = captionTracks.map(track => ({
      name: track.name.simpleText,
      code: track.languageCode
    }));

    // Function to fetch transcript
    const fetchTranscript = async (videoId, languageCode) => {
      const transcript = await getSubtitles({ videoID: videoId, lang: languageCode });
      return transcript.map(item => item.text).join(' ');
    };

    const transcriptArray = [];
    let selectedTranscriptText = '';
    let selectedLanguageCode = '';

    if (lang) {
      const langTrack = captionTracks.find(track => track.languageCode === lang);
      if (!langTrack) {
        return res.status(404).json({ message: `No captions available in the requested language (${lang}).` });
      }

      selectedLanguageCode = lang;
      selectedTranscriptText = await fetchTranscript(videoId, lang);

      transcriptArray.push({
        language: lang,
        title: videoInfo.videoDetails.title,
        transcript: selectedTranscriptText
      });
    } else {
      let preferredTrack = captionTracks.find(track => track.languageCode.startsWith('en') && track.kind !== 'asr')
                          || captionTracks.find(track => track.languageCode.startsWith('en'))
                          || captionTracks[0];

      selectedLanguageCode = preferredTrack.languageCode;
      selectedTranscriptText = await fetchTranscript(videoId, selectedLanguageCode);

      transcriptArray.push({
        language: selectedLanguageCode,
        title: videoInfo.videoDetails.title,
        transcript: selectedTranscriptText
      });
    }

    // Save to Firebase
    await docRef.set({
      videoID: videoId,
      duration: duration,
      transcript: transcriptArray,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Transcript saved to Firebase for ${videoId}`);

    // Return only selected transcript
    res.json({
      videoID: videoId,
      duration: duration,
      title: videoInfo.videoDetails.title,
      transcript: selectedTranscriptText,
      transcriptLanguageCode: selectedLanguageCode,
      languages: languages.length > 1 ? languages : undefined,
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

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on port ${port}`);
  logger.info(`Server is running on port ${port}`);
  console.log('Server started at:', new Date().toISOString());
  logger.info('Server started at:', new Date().toISOString());
});
