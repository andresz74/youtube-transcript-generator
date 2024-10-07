# YouTube Transcript and Video Info Service
This is an Express-based service that fetches YouTube video information and transcripts (subtitles) in English. It uses the [ytdl-core](https://github.com/fent/node-ytdl-core) library to extract video metadata and the [youtube-captions-scraper](https://www.npmjs.com/package/youtube-captions-scraper) library to retrieve subtitles from YouTube videos.

## Features
- Fetch basic video info like title, author, description, genre, and more.
- Extract English (auto-generated) subtitles for YouTube videos.
- Returns the start time, end time, and text of each subtitle.
- Provides a simplified transcript option with a concatenated transcript.

## Prerequisites
- [Node.js](https://nodejs.org/) (version 12.x or higher)
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)

## Installation
1. Clone this repository:

   ```bash
   git clone https://github.com/andresz74/youtube-transcript-generator.git
   ```

2. Navigate to the project directory:

   ```bash
   cd youtube-transcript-generator
   ```

3. Install the dependencies:

   ```bash
   npm install
   ```

## Usage
1. Start the server:

   ```bash
   npm start
   ```

   By default, the server runs on port `3004`. You can change this by setting the `PORT` environment variable.

2. Make a POST request to `/transcript` or `/simple-transcript` with a JSON body containing the YouTube video URL.

   Example request:

   ```json
   {
     "url": "https://www.youtube.com/watch?v=VIDEO_ID"
   }
   ```

3. Example response for `/transcript`:

   ```json
   {
     "code": 100000,
     "message": "success",
     "data": {
       "videoId": "VIDEO_ID",
       "videoInfo": {
         "name": "Video Title",
         "thumbnailUrl": {
           "hqdefault": "https://i.ytimg.com/vi/VIDEO_ID/hqdefault.jpg"
         },
         "embedUrl": "https://www.youtube.com/embed/VIDEO_ID",
         "duration": "300",  // in seconds
         "description": "Video description goes here...",
         "upload_date": "2023-09-01",
         "genre": "Education",
         "author": "Channel Name",
         "channel_id": "CHANNEL_ID"
       },
       "language_code": [
         {
           "code": "en_auto_auto",
           "name": "English (auto-generated)"
         }
       ],
       "transcripts": {
         "en_auto_auto": {
           "custom": [
             {
               "start": 0,
               "end": 5.32,
               "text": "Hello and welcome to this video."
             },
             {
               "start": 5.33,
               "end": 10.23,
               "text": "In this tutorial, we will explore..."
             }
           ]
         }
       }
     }
   }
   ```

4. Example response for `/simple-transcript`:

   ```json
   {
     "duration": 14,
     "transcript": "when i was first tasked of designing and making a website..."
   }
   ```

## API Endpoints

### POST `/transcript`
Fetches video information and English subtitles for a YouTube video.

#### Request body
- `url`: (string, required) The full YouTube video URL.

#### Response
- `code`: Response code (`100000` for success).
- `message`: Response message.
- `data`: An object containing:
  - `videoId`: The YouTube video ID.
  - `videoInfo`: An object with video details (name, thumbnail URL, duration, etc.).
  - `language_code`: A list of available subtitle languages.
  - `transcripts`: An object containing the video subtitles with start and end times.

### POST `/simple-transcript`
Fetches the full English transcript for a YouTube video in a simplified format.

#### Request body
- `url`: (string, required) The full YouTube video URL.

#### Response
- `comments`: Always `null`.
- `duration`: The video duration in minutes.
- `transcript`: The full transcript as a concatenated string.

## Error Handling
If an error occurs (e.g., invalid URL or subtitles not available), the service will return a `500` status code with an error message.

Example error response:

```json
{
  "message": "An error occurred while fetching the transcript."
}
```

## Environment Variables
- `PORT`: The port on which the server will run (default: `3004`).

## License
This project is licensed under the MIT License.