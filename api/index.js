require('dotenv').config();

const axios = require('axios');
const express = require('express');
const cors = require('cors');
const getSubtitles = require('youtube-captions-scraper').getSubtitles;

const app = express();
app.use(cors());
app.use(express.json());

// Base route
app.get('/', (req, res) => res.send('Express on Vercel'));

// Health check route
app.get('/api/health', (req, res) => {
    res.send('OK');
});

app.get('/api/debug', (req, res) => {
    res.json({
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        region: process.env.VERCEL_REGION || 'local',
    });
});

app.post('/api/simple-transcript', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url || !url.includes('youtube.com/watch')) {
            return res.status(400).json({ message: 'Invalid YouTube URL' });
        }

        const videoId = new URLSearchParams(new URL(url).search).get('v');
        if (!videoId) {
            return res.status(400).json({ message: 'Invalid YouTube URL' });
        }

        const apiKey = process.env.YOUTUBE_API_KEY;
        const videoDetailsResponse = await axios.get(
            `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${apiKey}&part=snippet,contentDetails`
        );

        if (videoDetailsResponse.data.items.length === 0) {
            return res.status(404).json({ message: 'Video not found' });
        }

        const videoDetails = videoDetailsResponse.data.items[0];
        const { title } = videoDetails.snippet;
        const duration = videoDetails.contentDetails.duration;

        // Fetch subtitles
        let transcriptText = '';
        try {
            const transcript = await getSubtitles({
                videoID: videoId,
                lang: 'en',
            });

            transcriptText = transcript.length
                ? transcript.map((item) => item.text).join(' ') 
                : 'No captions available for this video. Captions may be restricted in your region.';;
        } catch (captionError) {
            console.warn(`Captions not available for video: ${videoId}`);
        }

        res.json({
            title,
            duration,
            transcript: transcriptText || 'No captions available for this video.',
        });
    } catch (error) {
        console.error('Error Details:', {
            message: error.message,
            stack: error.stack,
            statusCode: error.response?.status,
            data: error.response?.data,
        });

        res.status(500).json({
            message: 'An error occurred while processing your request.',
        });
    }
});


// Catch-all route for debugging unmatched paths
app.use((req, res) => {
    console.log(`Unmatched Path: ${req.path}`);
    res.status(404).send(`Unmatched Path: ${req.path}`);
});

// Export the app for serverless environments (e.g., Vercel)
module.exports = app;