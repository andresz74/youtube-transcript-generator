# YouTube Transcript and Video Info Service

This is an Express-based service that fetches YouTube video information and transcripts (subtitles) in English. It uses the [ytdl-core](https://github.com/fent/node-ytdl-core) library to extract video metadata and the [youtube-captions-scraper](https://www.npmjs.com/package/youtube-captions-scraper) library to retrieve subtitles from YouTube videos.

![Backend Service](https://objects-us-east-1.dream.io/az-assets/youtube-transcript-generator.png "YouTube Transcript Generator")

## Features

- Fetch basic video info like title, author, description, genre, and more.
- Extract English (auto-generated) subtitles for YouTube videos.
- Returns the start time, end time, and text of each subtitle.
- Provides simplified and smart options to avoid duplicate processing.
- Supports saving transcripts and summaries to Firebase Firestore for caching and reuse.

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

4. Create a `.env` file with your configuration:

   ```env
   PORT=3004
   CHATGPT_VERCEL_URL=https://xxxxxxxxxx.vercel.app/api/openai-chat
   ```

5. Create a Firebase service account key file as `firebaseServiceAccount.json` (not committed to Git). Make sure you’ve set up Firestore.

## Usage

Start the server:

```bash
npm start
```

Or, using PM2:

```bash
pm2 start ecosystem.config.js
```

## API Endpoints

### ✅ POST `/transcript`

Fetches full video info + timestamped transcript.

**Request:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

**Response:** Full video info, subtitles with timestamps.

---

### ✅ POST `/simple-transcript`

Returns only the video title and concatenated English transcript as a string.

**Request:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

**Response:**

```json
{
  "duration": 14,
  "title": "Video Title",
  "transcript": "This is the transcript..."
}
```

---

Here’s an updated section for your README that introduces the **smart endpoints**, explains the motivation, notes the Firebase requirement, and gives basic setup instructions for the `firebaseServiceAccount.json` file.

---

### 💡 Smart Caching with Firebase (for Transcripts and Summaries)

To avoid fetching and reprocessing the same YouTube video over and over, this service provides **smart endpoints** that **store and reuse results** using **Firebase Firestore**. These endpoints check whether a transcript or summary already exists in the database before doing any expensive computation or API calls.

This is ideal when you're using the service from a frontend (e.g., a Chrome Extension) where caching can significantly speed things up and reduce costs (e.g., OpenAI API requests).

---

### 🔐 Requirements for Using Smart Endpoints

You need to set up your own **Firebase project** and configure Firestore access for the service. Here's what you need to do:

#### 1. Create a Firebase Project

- Go to [https://console.firebase.google.com](https://console.firebase.google.com)
- Click **Add project** → name it → continue
- In the left panel, go to **Firestore Database**
- Click **Create database**, start in production or test mode

#### 2. Generate a Firebase Admin SDK Service Account

- Go to your project settings (⚙️ > Project settings)
- Click **Service accounts**
- Click **Generate new private key** under the **Firebase Admin SDK**
- Save the JSON file and rename it to:

```bash
firebaseServiceAccount.json
```

- Place this file in the root of the project (where your `index.js` lives)

> ⚠️ **DO NOT COMMIT** this file to Git or push it to any public repo.

#### 3. Enable Firestore API (if needed)

Sometimes Firestore is not enabled by default in your Google Cloud project. You can enable it at:

[https://console.cloud.google.com/apis/library/firestore.googleapis.com](https://console.cloud.google.com/apis/library/firestore.googleapis.com)

---

### 🧠 POST `/smart-transcript`

This endpoint checks if the transcript is already stored in Firestore. If found, it returns the saved version. If not, it fetches it from YouTube, saves it, and returns it.

#### Request:

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

#### Response:

```json
{
  "videoId": "VIDEO_ID",
  "title": "Video Title",
  "duration": 14,
  "transcript": "Full transcript text..."
}
```

---

### 🧠 POST `/smart-summary`

This endpoint checks Firestore for a summary of the video. If one exists, it's returned. If not, it uses the **ChatGPT API** to generate the summary (using the transcript), stores it in Firestore, and returns it.

You should send the transcript from the frontend if you already have it, to avoid duplicating the work of fetching it again.

#### Request:

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "transcript": "Optional: transcript string"
}
```

#### Response:

```json
{
  "summary": "This is the summary of the transcript.",
  "fromCache": true
}
```

- `fromCache: true` → the summary was loaded from Firestore
- `fromCache: false` → it was freshly generated using ChatGPT

---

Let me know if you’d like this merged into the full README or want to include Firebase Firestore schema guidance (e.g., how the `transcripts` and `summaries` collections are structured).

---

## PM2 Notes

To start the server with PM2:

```bash
pm2 start ecosystem.config.js
```

Your `ecosystem.config.js` may look like this:

```js
module.exports = {
  apps: [
    {
      name: 'youtube-transcript-generator',
      script: './index.js',
      watch: false,
      env: {
        PORT: 3004,
        CHATGPT_VERCEL_URL: 'https://your-vercel-url/api/openai-chat'
      }
    }
  ]
};
```

To monitor logs:

```bash
pm2 logs youtube-transcript-generator
```

---

## License

This project is licensed under the MIT License.