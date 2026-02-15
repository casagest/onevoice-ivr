const express = require("express");
const { OpenAI } = require("openai");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ═══════════════════════════════════════════════════════════════
// SYSTEM PROMPTS — Dental & Agri
// ═══════════════════════════════════════════════════════════════

const PROMPTS = {
  dental: `Ești OneVoice Dental, asistent vocal AI pentru clinica MedicalCor.
Răspunzi în limba în care ți se vorbește (română default).
Ești cald, profesionist, concis (max 3 propoziții per răspuns).

Poți ajuta cu:
- Informații despre tratamente dentare (implant, coroană, albire, ortodonție)
- Prețuri orientative (implant: 500-800€, coroană: 200-400€, albire: 150-300€)
- Programări (colectezi nume + telefon + ce problemă au)
- Urgențe dentare (durere acută → recomandă ibuprofen 400mg + "veniți de urgență")
- Întrebări frecvente (durere post-extracție, cât durează un implant, etc.)

IMPORTANT:
- NU da diagnostice. Spune mereu "doctorul va evalua la consultație".
- Pentru urgențe severe (sângerare care nu se oprește, febră >38.5°C post-procedură) → "Sunați 112 sau mergeți la urgențe".
- Colectează MEREU un număr de telefon pentru callback dacă vor programare.
- Fii empatic cu frica de dentist — e normală.`,

  agri: `Ești OneVoice Agri, asistent vocal AI pentru fermieri.
Răspunzi în limba în care ți se vorbește (română default).
Ești practic, concis, respectuos (max 3 propoziții per răspuns).
Data curentă: ${new Date().toLocaleDateString('ro-RO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.
Luna curentă: ${new Date().toLocaleString('ro-RO', { month: 'long' })}. Sezonul: ${['iarnă','iarnă','primăvară','primăvară','primăvară','vară','vară','vară','toamnă','toamnă','toamnă','iarnă'][new Date().getMonth()]}.

Poți ajuta cu:
- Identificarea bolilor plantelor (descriu simptome → sugerezi cauze posibile)
- Recomandări tratamente (fungicide, insecticide, doze orientative)
- Calendar agricol (când se plantează, când se recoltează, în funcție de zonă)
- Sfaturi sezoniere bazate pe luna curentă (știi luna și sezonul, folosește-le)
- Informații subvenții APIA / fermier

IMPORTANT:
- NU ai acces la date meteo în timp real. Dacă te întreabă de vreme, spune: "Nu am acces la prognoza meteo exactă, dar pentru luna aceasta în România de obicei..." și dă sfaturi generale sezoniere.
- NU recomanda produse specifice de brand fără să menționezi alternativele.
- Menționează MEREU: "Consultați un inginer agronom pentru doza exactă".
- Pentru probleme cu animale → "Sunați medicul veterinar, nu întârziați".
- Respectă experiența fermierului — ei știu mult, tu completezi.`,
};

// ═══════════════════════════════════════════════════════════════
// CONVERSATION MEMORY — per call
// ═══════════════════════════════════════════════════════════════

const conversations = new Map();

function getConversation(callSid) {
  if (!conversations.has(callSid)) {
    conversations.set(callSid, { messages: [], mode: null, turns: 0 });
  }
  return conversations.get(callSid);
}

function cleanOldConversations() {
  // Cleanup conversations older than 30 min
  const now = Date.now();
  for (const [sid, conv] of conversations) {
    if (now - (conv.startedAt || 0) > 30 * 60 * 1000) {
      conversations.delete(sid);
    }
  }
}
setInterval(cleanOldConversations, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// ROUTE: Incoming call — Main menu
// ═══════════════════════════════════════════════════════════════

app.post("/voice", (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;

  console.log(`📞 Incoming call: ${callSid} from ${req.body.From}`);

  // Initialize conversation
  const conv = getConversation(callSid);
  conv.startedAt = Date.now();

  const gather = twiml.gather({
    numDigits: 1,
    action: "/menu-select",
    method: "POST",
    timeout: 5,
    language: "ro-RO",
  });

  gather.say(
    {
      voice: "Google.ro-RO-Wavenet-A",
      language: "ro-RO",
    },
    "Bună! Sunt OneVoice, asistentul tău vocal. " +
      "Apasă 1 pentru asistență dentară. " +
      "Apasă 2 pentru sfaturi agricole. " +
      "Sau rămâi pe linie și vorbește-mi direct."
  );

  // If no input, default to free conversation (dental)
  twiml.redirect("/voice-input?mode=dental");

  res.type("text/xml");
  res.send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: Menu selection
// ═══════════════════════════════════════════════════════════════

app.post("/menu-select", (req, res) => {
  const twiml = new VoiceResponse();
  const digit = req.body.Digits;
  const callSid = req.body.CallSid;
  const conv = getConversation(callSid);

  let mode = "dental";
  let greeting = "";

  if (digit === "1") {
    mode = "dental";
    greeting =
      "Bine ai venit la asistența dentară MedicalCor. Cum te pot ajuta?";
  } else if (digit === "2") {
    mode = "agri";
    greeting = "Bine ai venit la asistența agricolă. Cu ce te pot ajuta?";
  } else {
    // Invalid digit, replay menu
    twiml.say(
      { voice: "Polly.Carmen-Neural", language: "ro-RO" },
      "Nu am înțeles. Hai să încercăm din nou."
    );
    twiml.redirect("/voice");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  conv.mode = mode;
  console.log(`🎯 Call ${callSid} selected mode: ${mode}`);

  // Greet and gather first speech input
  const gather = twiml.gather({
    input: "speech",
    action: `/process-speech?mode=${mode}`,
    method: "POST",
    speechTimeout: "auto",
    language: "ro-RO",
    timeout: 8,
  });

  gather.say(
    { voice: "Polly.Carmen-Neural", language: "ro-RO" },
    greeting
  );

  // If no speech, prompt again
  twiml.say(
    { voice: "Polly.Carmen-Neural", language: "ro-RO" },
    "Nu am auzit nimic. Poți să repeți?"
  );
  twiml.redirect(`/voice-input?mode=${mode}`);

  res.type("text/xml");
  res.send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: Voice input (gather speech)
// ═══════════════════════════════════════════════════════════════

app.post("/voice-input", (req, res) => {
  const twiml = new VoiceResponse();
  const mode = req.query.mode || "dental";

  const gather = twiml.gather({
    input: "speech",
    action: `/process-speech?mode=${mode}`,
    method: "POST",
    speechTimeout: "auto",
    language: "ro-RO",
    timeout: 10,
  });

  gather.say(
    { voice: "Polly.Carmen-Neural", language: "ro-RO" },
    "Te ascult."
  );

  // If still no speech after timeout
  twiml.say(
    { voice: "Polly.Carmen-Neural", language: "ro-RO" },
    "Se pare că avem probleme cu conexiunea. Încearcă să suni din nou. La revedere!"
  );
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: Process speech → OpenAI → Respond
// ═══════════════════════════════════════════════════════════════

app.post("/process-speech", async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;
  const confidence = parseFloat(req.body.Confidence || "0");
  const mode = req.query.mode || "dental";

  console.log(
    `🗣️  [${callSid}] Speech: "${speechResult}" (confidence: ${confidence})`
  );

  // No speech detected
  if (!speechResult) {
    twiml.say(
      { voice: "Polly.Carmen-Neural", language: "ro-RO" },
      "Nu am înțeles. Poți să repeți te rog?"
    );
    twiml.redirect(`/voice-input?mode=${mode}`);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Check for goodbye
  const bye = /\b(pa|la revedere|gata|mulțumesc|bye|stop)\b/i;
  if (bye.test(speechResult)) {
    twiml.say(
      { voice: "Polly.Carmen-Neural", language: "ro-RO" },
      "Mulțumesc că ai sunat! Sănătate și o zi frumoasă! La revedere!"
    );
    twiml.hangup();
    conversations.delete(callSid);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Build conversation context
  const conv = getConversation(callSid);
  conv.mode = mode;
  conv.turns++;
  conv.messages.push({ role: "user", content: speechResult });

  // Limit conversation history to last 10 turns
  const recentMessages = conv.messages.slice(-10);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: PROMPTS[mode] },
        ...recentMessages,
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    const reply = completion.choices[0].message.content;
    conv.messages.push({ role: "assistant", content: reply });

    console.log(`🤖 [${callSid}] Reply: "${reply}"`);

    // Speak the reply, then listen for more
    const gather = twiml.gather({
      input: "speech",
      action: `/process-speech?mode=${mode}`,
      method: "POST",
      speechTimeout: "auto",
      language: "ro-RO",
      timeout: 10,
    });

    gather.say({ voice: "Polly.Carmen-Neural", language: "ro-RO" }, reply);

    // If no more speech, polite goodbye
    twiml.say(
      { voice: "Polly.Carmen-Neural", language: "ro-RO" },
      "Dacă mai ai întrebări, sună oricând. La revedere!"
    );
    twiml.hangup();
  } catch (err) {
    console.error(`❌ [${callSid}] OpenAI error:`, err.message);

    twiml.say(
      { voice: "Polly.Carmen-Neural", language: "ro-RO" },
      "Îmi pare rău, am o problemă tehnică momentan. Te rog sună din nou în câteva minute."
    );
    twiml.hangup();
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: Call status callback (logging)
// ═══════════════════════════════════════════════════════════════

app.post("/call-status", (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  console.log(
    `📊 Call ${CallSid}: ${CallStatus} (duration: ${CallDuration || "?"}s)`
  );

  if (CallStatus === "completed" || CallStatus === "failed") {
    conversations.delete(CallSid);
  }

  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: Health check
// ═══════════════════════════════════════════════════════════════

app.get("/", (req, res) => {
  res.json({
    name: "OneVoice IVR",
    status: "🟢 LIVE",
    version: "1.0.0",
    phone: "+15179032276",
    modes: ["dental", "agri"],
    activeCalls: conversations.size,
    uptime: Math.floor(process.uptime()) + "s",
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║          🎙️  OneVoice IVR — LIVE             ║
║                                              ║
║  Port:    ${PORT}                              ║
║  Phone:   +1 (517) 903-2276                  ║
║  Modes:   Dental 🦷  |  Agri 🌾              ║
║  AI:      GPT-4o-mini                        ║
║                                              ║
║  Endpoints:                                  ║
║    POST /voice          ← Twilio webhook     ║
║    POST /menu-select    ← DTMF routing       ║
║    POST /voice-input    ← Speech gather      ║
║    POST /process-speech ← AI processing      ║
║    POST /call-status    ← Status callback    ║
║    GET  /               ← Health dashboard   ║
║                                              ║
╚══════════════════════════════════════════════╝
  `);
});
