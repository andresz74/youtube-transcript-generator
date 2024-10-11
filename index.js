const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const getSubtitles = require('youtube-captions-scraper').getSubtitles;

const app = express();
app.use(cors());
app.use(express.json());

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
        const transcript = await getSubtitles({
            videoID: videoId,
            lang: 'en'
        });

        // Combine all transcript items into a single string
        const transcriptText = transcript.map(item => item.text).join(' ');

        // Prepare the simple response format
        const response = {
            duration: duration,
            transcript: transcriptText
        };

        // Send the simplified transcript response
        res.json(response);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'An error occurred while fetching the simple transcript.' });
    }
});

const port = process.env.PORT || 3004;
app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on port ${port}`);
});
