require('dotenv').config();

const axios = require('axios');
const express = require('express');
const cors = require('cors');
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
  console.log('Request size:', req.headers['content-length']);  // Log the content-length
  next();
});


// Health check route
app.get('/health', (req, res) => {
    res.send('OK');
});

// Debug
app.get('/debug', (req, res) => {
    res.json({
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        region: process.env.VERCEL_REGION || 'local',
    });
});

// Existing transcript endpoint
app.post('/transcript', async (req, res) => {
    try {
        const { url } = req.body;

        // Extract video ID from URL
        const videoId = ytdl.getURLVideoID(url);

        // Get video info (e.g., title, author, etc.)
        const videoInfo = await ytdl.getBasicInfo(url);

        // Fetch the transcript
        const transcript = await getSubtitles({
            videoID: videoId, // youtube video id
            lang: 'en' // default to English
        });

        // Prepare the response in the desired format
        const response = {
            code: 100000,
            message: 'success',
            data: {
                videoId: videoId,
                videoInfo: {
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
                language_code: [
                    {
                        code: 'en_auto_auto',
                        name: 'English (auto-generated)'
                    }
                ],
                transcripts: {
                    en_auto_auto: {
                        custom: transcript.map((item) => ({
                            start: item.start,
                            end: item.start + item.dur,
                            text: item.text
                        }))
                    }
                }
            }
        };

        // Send response
        res.json(response);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'An error occurred while fetching the transcript.' });
    }
});

app.post('/simple-transcript', async (req, res) => {
    try {
        const { url } = req.body;

        // Extract video ID from URL
        const videoId = ytdl.getURLVideoID(url);

        // Get video info (e.g., duration)
        const videoInfo = await ytdl.getBasicInfo(url);
        const duration = Math.floor(videoInfo.videoDetails.lengthSeconds / 60); // Convert to minutes

        // Fetch the transcript
        
        try {
          const transcript = await getSubtitles({
            videoID: videoId,
            lang: 'en'
          });

          if (!transcript || transcript.length === 0) {
            throw new Error('No English captions available for this video.');
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
        } catch (transcriptError) {
          console.error('Error fetching transcript:', transcriptError.message);
          res.status(404).json({ message: 'No transcript found for this video.' });
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'An error occurred while fetching the simple transcript.' });
    }
});

// smart-transcript endpoint
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

    // Get video info
    const videoInfo = await ytdl.getBasicInfo(url);
    const duration = Math.floor(videoInfo.videoDetails.lengthSeconds / 60);  // Convert to minutes

    // Fetch the transcript
    try {
      const transcript = await getSubtitles({ videoID: videoId, lang: 'en' });
      if (!transcript || transcript.length === 0) {
        throw new Error('No English captions available for this video.');
      }

      // Combine all transcript items into a single string
      const transcriptText = transcript.map(item => item.text).join(' ');

      // Chunk the transcript into smaller pieces (e.g., by character limit)
      const chunkSize = 5000;  // Define a reasonable chunk size (5000 characters in this example)
      const chunks = [];

      for (let i = 0; i < transcriptText.length; i += chunkSize) {
        chunks.push(transcriptText.slice(i, i + chunkSize));
      }

      // Store the chunks in Firestore
      await docRef.set({
        videoId,
        title: videoInfo.videoDetails.title,
        duration,
        transcript: transcriptText,  // You can also store the full transcript here if needed
        chunks,  // Store the chunks separately
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Full transcript and chunks stored in Firebase for ${videoId}`);

      // Return a response with the full transcript and chunk information
      res.json({
        videoId,
        title: videoInfo.videoDetails.title,
        duration,
        transcript: transcriptText,
        chunks: chunks.length,
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


// smart-summary endpoint
// Model URL mapping
const modelUrls = {
  chatgpt: process.env.CHATGPT_VERCEL_URL,
  deepseek: process.env.DEEPSEEK_VERCEL_URL,
  // Add new models here, e.g.:
  // myNewModel: process.env.MY_NEW_MODEL_URL,
};

app.post('/smart-summary', async (req, res) => {
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
    if (!modelUrl) {
      return res.status(400).json({ message: 'Invalid model specified' });
    }

    const response = await axios.post(modelUrl, {
      videoId  // Only send the video ID
    });

    const summary = response.data.choices?.[0]?.message?.content;

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


  
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on port ${port}`);
});
