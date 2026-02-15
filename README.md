# 🎙️ OneVoice IVR

Voice AI assistant — dental & agricultural. Call and talk.

**Phone:** +1 (517) 903-2276

## Deploy on Render (5 minutes)

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Settings are auto-detected from `render.yaml`
5. Add environment variable: `OPENAI_API_KEY` = your key
6. Deploy

## Configure Twilio

1. Go to [Twilio Console](https://console.twilio.com) → Phone Numbers → +15179032276
2. Under "Voice & Fax":
   - **A CALL COMES IN:** Webhook → `https://YOUR-APP.onrender.com/voice` → POST
   - **CALL STATUS CHANGES:** `https://YOUR-APP.onrender.com/call-status` → POST
3. Save

## Test locally

```bash
npm install
OPENAI_API_KEY=sk-xxx node server.js
# Use ngrok to expose: ngrok http 3000
# Set Twilio webhook to ngrok URL
```

## How it works

1. Call +1 (517) 903-2276
2. Press 1 for dental, 2 for agriculture
3. Speak your question in Romanian
4. AI responds with voice
5. Continue the conversation naturally
6. Say "la revedere" to hang up
