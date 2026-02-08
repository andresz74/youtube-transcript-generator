# YouTube Transcript and Video Info Service Documentation

---

## **Overview**

This Express-based service fetches YouTube video information (metadata) and transcripts (subtitles) in any available language. It uses the `ytdl-core` library to extract video metadata and the `youtube-captions-scraper` library to retrieve subtitles. Firebase Firestore is used to cache the results (transcripts and summaries) to prevent repetitive fetching and improve performance.

**Runtime notes**
- `yt-dlp` is used for transcript extraction.
- `deno` is required for yt-dlp JS challenges.
- `all_cookies.txt` (Netscape format) must be present at the project root.
- Set `API_ACCESS_KEY` in this service to authenticate model requests against the `ai-access` API (`X-API-Key`/Bearer).

---

## **Service Endpoints**

### 1. **POST `/smart-transcript-v2`**

**Description**
Checks Firestore for a transcript of the YouTube video. If missing, fetches transcript (yt-dlp/json3 + fallbacks), title, description, date, image, inferred tags, and stores them all in Firestore.

**Request Body:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

**Response 200:**

```json
{
  "videoID": "VIDEO_ID",
  "title": "Video Title",
  "duration": 14,
  "transcript": "Full transcript text...",
  "description": "First line of the video description",
  "date": "2025-01-26",
  "image": "https://i.ytimg.com/vi/VIDEO_ID/maxresdefault.jpg",
  "tags": ["ios", "automation", "shortcuts"],
  "canonical_url": "https://blog.andreszenteno.com/notes/video-title"
}
```

---

### 2. **POST `/smart-summary-firebase-v2`**

**Description**
Checks Firestore for an existing summary. If not found, generates an AI-powered summary and tags using OpenAI, formats it with Markdown frontmatter, and saves it to `summaries` and `transcripts` collections.

**Request Body:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "model": "openai"
}
```

**Response 200:**

```json
{
  "summary": "---\ntitle: \"Video Title\"\ndate: 2025-01-26\ntags:\n  - ios\n  - automation\n  - shortcuts\n---\n...summary...",
  "fromCache": false
}
```

* Uses the deployed AI service `/api/openai-chat-youtube-transcript-v2` to fetch `summary` and `tags`.
* Markdown-compatible output can be used in Obsidian, static blogs, etc.
* Tags are stored in both collections for indexing and reuse.

---

### 3. **POST `/transcript`**

This endpoint retrieves full YouTube video information and timestamped captions (subtitles) in all available languages. It fetches video metadata (e.g., title, description, etc.) and subtitles (with timestamps) for all languages supported by the video.

#### **Request Body:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

- `url`: The URL of the YouTube video from which you want to fetch the transcript and video info.

#### **Response:**

```json
{
  "status": "success",
  "status_code": 200,
  "message": "success",
  "data": {
    "videoID": "VIDEO_ID",
    "videoInfo": {
      "name": "Video Title",
      "thumbnailUrl": {
        "hqdefault": "URL"
      },
      "embedUrl": "https://www.youtube.com/embed/VIDEO_ID",
      "duration": 120,
      "description": "Video description",
      "upload_date": "2025-01-01",
      "genre": "Music",
      "author": "Video Author",
      "channel_id": "CHANNEL_ID"
    },
    "language_code": [
      {
        "code": "en",
        "name": "English"
      },
      {
        "code": "es",
        "name": "Spanish"
      }
    ],
    "transcripts": {
      "en": {
        "custom": [
          {
            "start": 0,
            "end": 10,
            "text": "Hello World"
          },
          ...
        ]
      },
      "es": {
        "custom": [
          {
            "start": 0,
            "end": 10,
            "text": "Hola Mundo"
          },
          ...
        ]
      }
    }
  }
}
```

- **`videoID`**: Unique ID for the YouTube video.
- **`videoInfo`**: Metadata about the video, such as title, description, duration, etc.
- **`language_code`**: A list of available languages for the subtitles.
- **`transcripts`**: An object containing subtitles in all available languages with their respective timestamps and text.

---

### 4. **POST `/simple-transcript`**

This endpoint returns a simplified version of the transcript, which includes the video title and a concatenated string of subtitles in the first available language.

#### **Request Body:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

- `url`: The URL of the YouTube video.

#### **Response:**

```json
{
  "duration": 14,
  "title": "Video Title",
  "transcript": "This is the transcript..."
}
```

- **`duration`**: Duration of the video in minutes.
- **`title`**: Title of the video.
- **`transcript`**: Full transcript as a concatenated string.






### 5. **GET `/api/transcript`**

**Description**
Fetches captions for a YouTube video using the internal transcript fetcher.

**Request Query:**

```
/api/transcript?videoId=VIDEO_ID&lang=en
```

**Response 200:**

```json
{
  "videoId": "VIDEO_ID",
  "lang": "en",
  "captions": [
    { "start": 0, "duration": 3.2, "text": "Hello world" }
  ]
}
```

---

### 6. **POST `/simple-transcript-v3`**

**Description**
Fetches and returns the transcript of a YouTube video in a requested language (or default language if not specified). Caches transcripts per language for faster future access.

**Request Body**

```json
{
  "url": "string (required) - YouTube video URL",
  "lang": "string (optional) - Language code (e.g. en, es, en-US)"
}
```

**Response 200**

```json
{
  "videoID": "string",
  "duration": "number (minutes)",
  "title": "string",
  "transcript": "string",
  "transcriptLanguageCode": "string",
  "languages": [
    { "code": "string" }
  ],
  "videoInfoSummary": {
    "author": "string",
    "description": "string",
    "embed": "object",
    "thumbnails": "array",
    "viewCount": "string",
    "publishDate": "string",
    "video_url": "string"
  }
}
```

**Response 404**

```json
{
  "message": "No captions available for this video."
}
```

**Response 500**

```json
{
  "message": "An error occurred while fetching and saving the transcript."
}
```

**Notes**

* `languages` is only included if more than one caption language is available.
* Cached transcripts are automatically updated and stored by video ID and language.

---

### 7. **POST `/smart-transcript`**

This endpoint checks Firestore for an existing transcript for the specified YouTube video. If it exists, the cached version is returned. If not, it fetches the transcript, stores it in Firestore, and returns the result.

#### **Request Body:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

- `url`: The URL of the YouTube video.

#### **Response:**

```json
{
  "videoID": "VIDEO_ID",
  "title": "Video Title",
  "duration": 14,
  "transcript": "Full transcript text..."
}
```

- **`videoID`**: Unique video ID.
- **`title`**: Video title.
- **`duration`**: Video duration in minutes.
- **`transcript`**: Full transcript.

---

### 8. **POST `/smart-summary`**

This endpoint checks Firestore for a summary of the specified YouTube video. If a summary exists, it is returned from the cache. If not, the service uses the provided transcript (or fetches it from YouTube) and generates a summary using a model (e.g., ChatGPT).

#### **Request Body:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "transcript": "Optional: transcript string",
  "model": "chatgpt"  // Can be 'chatgpt', 'deepseek', or 'anthropic'
}
```

- `url`: The URL of the YouTube video.
- `transcript`: Optional parameter; provide if you already have the transcript.
- `model`: Specify which model to use for generating the summary (e.g., `chatgpt`, `deepseek`, `anthropic`).

#### **Response:**

```json
{
  "summary": "This is the summary of the transcript.",
  "fromCache": true
}
```

- **`summary`**: The generated summary.
- **`fromCache`**: Indicates whether the summary was retrieved from Firestore (`true`) or freshly generated (`false`).

---

### 9. **POST `/smart-summary-firebase`**

This endpoint operates similarly to `/smart-summary`, but it offloads the summary generation and caching to Firestore itself. It sends only the video ID to a model to generate the summary, stores it in Firestore, and returns the summary.

#### **Request Body:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "model": "chatgpt"
}
```

- `url`: The URL of the YouTube video.
- `model`: Specify which model to use for generating the summary (e.g., `chatgpt`, `deepseek`, `anthropic`).

#### **Response:**

```json
{
  "summary": "This is the summary of the transcript.",
  "fromCache": true
}
```

- **`summary`**: The generated summary.
- **`fromCache`**: Indicates whether the summary was retrieved from Firestore (`true`) or freshly generated (`false`).

---

### 10. **GET `/health`**

A simple health check endpoint to verify that the service is running.

#### **Response:**

```text
OK
```

---

### 11. **GET `/debug`**

A debug endpoint that returns the IP address and region of the requestor.

#### **Response:**

```json
{
  "ip": "IP_ADDRESS",
  "region": "REGION"
}
```

- **`ip`**: IP address of the requester.
- **`region`**: Region where the server is running (e.g., `local` or `VERCEL_REGION` if deployed).

---

### 12. **POST `/smart-summary-firebase-v3`**

This endpoint enhances `/smart-summary-firebase-v2` by retrieving rich metadata (e.g., category, video author, published date) from Firestore. It generates a structured summary using an external model endpoint and wraps the result in a Markdown document with YAML frontmatter. The summary is then cached in Firestore for future requests.

#### **Request Body:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "model": "chatgpt"  // Or "anthropic", "deepseek", etc.
}
```

- **`url`**: Full YouTube video URL.
- **`model`**: AI model to use for summary generation.

### **Response**

```json
{
  "summary": "---\\ntitle: \\"...\\",\\ndate: ...\\ndescription: ...\\ntags: [...]\\n---\\nSummary content...",
  "fromCache": false
}
```
- **`summary`**: Full Markdown output with frontmatter.
- **`fromCache`**: true if retrieved from Firestore, otherwise false.

### **Highlights:**

- Adds extended metadata to the summary frontmatter (e.g., video_author, published_date, video_id, etc.).
- Sends only the videoID to the AI endpoint for summary generation.
- Stores result in summaries collection in Firestore.
- Generates tags from title/description/summary when none exist.

---

## **Firebase Firestore Caching**

The service uses Firebase Firestore to cache transcripts and summaries for YouTube videos. If a transcript or summary has already been processed for a video, it will be fetched from Firestore to avoid redundant processing.

### Firestore Collection Structure

- **`transcripts`**: Contains documents for each YouTube video with the video ID as the document ID. The document contains the full transcript and metadata.
- **`summaries`**: Contains documents for each YouTube video with the video ID as the document ID. The document contains the video summary.

---

## **Usage with Firebase**

---

## **Environment Flags**

- `TRANSCRIPT_DEBUG=true` enables verbose transcript fetch logs.
- `SUMMARY_DEBUG=true` enables verbose model response logs.

---

## **Troubleshooting**

- **Empty transcripts**: Ensure `all_cookies.txt` is fresh, `yt-dlp` is up to date, and `deno` is installed. Re-run a local check:
  ```bash
  yt-dlp --cookies all_cookies.txt --js-runtimes deno --list-subs "https://www.youtube.com/watch?v=VIDEO_ID"
  ```
- **yt-dlp missing**: Install or update from the official release and ensure `/usr/local/bin` is in `PATH`.
- **Verbose logs**: Set `TRANSCRIPT_DEBUG=true` or `SUMMARY_DEBUG=true` in `.env`.

---

## **Operational Checklist**

- Refresh `all_cookies.txt` on the same server where PM2 runs.
- Verify `yt-dlp --version` and `yt-dlp --list-subs` work from the server.
- Confirm `deno` is installed and usable by `yt-dlp --js-runtimes deno`.
- Restart PM2 after any cookie or dependency changes.

---

## **Security Notes**

- Never commit `all_cookies.txt` or `firebaseServiceAccount.json`.
- Rotate YouTube cookies if they are ever exposed in logs or chat.
- Treat `.env` and any model endpoint URLs as secrets.

Before using the Firebase caching system, you must set up Firebase Firestore and create a service account key:

1. **Create a Firebase Project** and enable Firestore.
2. **Generate a Firebase Admin SDK Service Account Key** and save it as `firebaseServiceAccount.json`.
3. **Place the `firebaseServiceAccount.json` file** in the root of the project.
4. **Ensure that Firestore is enabled** for your Firebase project.

---
