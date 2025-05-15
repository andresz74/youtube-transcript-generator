# YouTube Transcript and Video Info Service

This is an Express-based service that fetches YouTube video information and transcripts (subtitles) in any available language. It uses the [ytdl-core](https://github.com/fent/node-ytdl-core) library to extract video metadata and the [youtube-captions-scraper](https://www.npmjs.com/package/youtube-captions-scraper) library to retrieve subtitles from YouTube videos.

![Backend Service](https://objects-us-east-1.dream.io/az-assets/youtube-transcript-generator.png "YouTube Transcript Generator")

## Features

- Fetch basic video info like title, author, description, genre, and more.
- Extract subtitles in any available language for YouTube videos.
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

**Response:** Full video info, subtitles with timestamps in all available languages.

---

### ✅ POST `/simple-transcript`

Returns only the video title and concatenated transcript in the first available language.

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

### ✅ POST `/simple-transcript-v2`  

Returns the video title, duration, and concatenated transcript in a **user-specified language** (or falls back to English/first available language). Also includes a list of available languages if multiple exist.

**Request:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "lang": "es" // Optional: language code (e.g., "es" for Spanish)
}
```

**Response:**
```json
{
  "duration": 14,
  "title": "Video Title",
  "transcript": "Transcript text in the requested language...",
  "languages": [ // Only included if multiple languages available
    { "name": "English", "code": "en" },
    { "name": "Spanish", "code": "es" }
  ]
}
```

**Behavior:**
- If `lang` is specified, returns the transcript in that language (or errors if unavailable).
- If no `lang` is provided, prioritizes English (non-auto-generated) or falls back to the first available language.
- Includes `languages` array in the response when multiple subtitle tracks exist.

---

### 💡 Smart Caching with Firebase  
[Rest of the existing content remains unchanged...]

---

### Why Update?
The new `/simple-transcript-v2` endpoint improves upon `/simple-transcript` by:
1. Supporting **explicit language selection** via `lang` parameter.
2. Providing **transparency** about available languages.
3. Maintaining backward compatibility with the original response format when no language is specified.

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

### 🧠 POST `/smart-transcript-v2`

Fetches the transcript and metadata for a YouTube video, stores it in Firestore if not already present.

**Request:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

**Response:**

```json
{
  "videoId": "VIDEO_ID",
  "title": "Video Title",
  "duration": 14,
  "transcript": "Transcript text...",
  "description": "First line of the video description",
  "date": "2025-01-26",
  "image": "https://i.ytimg.com/vi/VIDEO_ID/maxresdefault.jpg",
  "tags": ["ios", "automation", "shortcuts"],
  "canonical_url": "https://blog.andreszenteno.com/notes/video-title"
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

### 🧠 POST `/smart-summary-firebase`

This endpoint provides similar functionality to `/smart-summary` but offloads the summary creation and caching to Firestore itself.

#### Request:

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "model": "chatgpt" // Specify which model to use (chatgpt, deepseek, anthropic)
}
```

#### Response:

```json
{
  "summary": "This is the summary of the transcript.",
  "fromCache": true
}
```

---

### ✅ POST `/smart-summary-firebase-v2`

Generates a markdown-formatted AI summary with frontmatter and tags. Caches both in Firestore.

**Request:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "model": "openai"
}
```

**Response:**

```json
{
  "summary": "---\ntitle: \"...\"\ndate: ...\ntags: [...]\n---\nSummary content...",
  "fromCache": false
}
```

* Uses OpenAI to generate both the summary and tags.
* Saves results to both `summaries` and `transcripts` collections in Firestore.
* Includes YouTube link and properly formatted frontmatter for markdown usage.

---

### 🧠 POST `/smart-summary-firebase-v3`

This endpoint improves upon v2 by retrieving extended video metadata from Firestore (such as category, video author, publish date) and formatting the summary as a Markdown document with a full YAML frontmatter block. The summary is cached in Firestore to avoid redundant AI calls.

**Request:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "model": "chatgpt" // or "anthropic", "deepseek", etc.
}
```

**Response**

```json
{
  "summary": "---\\ntitle: \\"...\\",\\ndate: ...\\ndescription: ...\\n...\\n---\\nSummary content...",
  "fromCache": false
}
```
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