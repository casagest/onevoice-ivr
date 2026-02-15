const express = require("express");
const { OpenAI } = require("openai");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Supabase client (logging)
const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════
// VOICE CONFIG
// ═══════════════════════════════════════════════════════════════

const VOICE = { voice: "Polly.Carmen-Neural", language: "ro-RO" };

// ═══════════════════════════════════════════════════════════════
// SYSTEM PROMPTS
// ═══════════════════════════════════════════════════════════════

const now = new Date();
const MONTH = now.toLocaleString("ro-RO", { month: "long" });
const SEASON = ["iarnă","iarnă","primăvară","primăvară","primăvară","vară","vară","vară","toamnă","toamnă","toamnă","iarnă"][now.getMonth()];
const DATE_STR = now.toLocaleDateString("ro-RO", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

const PROMPTS = {
  dental: `Ești OneVoice Dental, asistent vocal AI pentru clinica MedicalCor.
Răspunzi în limba în care ți se vorbește (română default).
Ești cald, profesionist, concis (max 2-3 propoziții per răspuns — ești pe TELEFON, nu text).

Poți ajuta cu:
- Informații tratamente dentare (implant, coroană, albire, ortodonție)
- Prețuri orientative (implant: 500-800€, coroană: 200-400€, albire: 150-300€)
- Programări (colectezi nume + telefon + ce problemă au)
- Urgențe dentare (durere acută → ibuprofen 400mg + "veniți de urgență")
- Întrebări frecvente (durere post-extracție, cât durează un implant, etc.)

REGULI:
- NU da diagnostice. Spune "doctorul va evalua la consultație".
- Urgențe severe (sângerare, febră >38.5°C) → "Sunați 112 sau mergeți la urgențe".
- Colectează MEREU un număr de telefon pentru callback dacă vor programare.
- Fii empatic cu frica de dentist.
- SCURT! Ești pe telefon, nu scrie eseuri.`,

  agri: `Ești OneVoice Agri, asistent vocal AI pentru fermieri.
Răspunzi în limba în care ți se vorbește (română default).
Ești practic, concis, respectuos (max 2-3 propoziții per răspuns — ești pe TELEFON).
Azi: ${DATE_STR}. Luna: ${MONTH}. Sezonul: ${SEASON}.

Poți ajuta cu:
- Identificarea bolilor plantelor (simptome → cauze posibile)
- Recomandări tratamente (fungicide, insecticide, doze orientative)
- Calendar agricol (ce se face luna asta)
- Sfaturi sezoniere pentru ${MONTH}
- Informații subvenții APIA / fermier

REGULI:
- NU ai date meteo real-time. Dă sfaturi pentru ${MONTH} în general.
- Menționează alternative, nu doar un produs.
- "Consultați un agronom pentru doza exactă."
- Probleme cu animale → "Sunați veterinarul, nu întârziați."
- SCURT! Ești pe telefon.`,
};

// ═══════════════════════════════════════════════════════════════
// CONVERSATION MEMORY
// ═══════════════════════════════════════════════════════════════

const conversations = new Map();

function getConv(callSid) {
  if (!conversations.has(callSid)) {
    conversations.set(callSid, {
      messages: [],
      mode: null,
      turns: 0,
      startedAt: Date.now(),
    });
  }
  return conversations.get(callSid);
}

// Cleanup old conversations every 5 min
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [sid, conv] of conversations) {
    if (conv.startedAt < cutoff) conversations.delete(sid);
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// DATABASE LOGGING
// ═══════════════════════════════════════════════════════════════

async function dbLogCall(callSid, from, mode) {
  if (!supabase) return;
  try {
    await supabase.from("calls").upsert({
      call_sid: callSid,
      from_number: from,
      mode: mode || "unknown",
      started_at: new Date().toISOString(),
      status: "active",
    }, { onConflict: "call_sid" });
  } catch (e) {
    log(`⚠️ DB log call error: ${e.message}`);
  }
}

async function dbLogTurn(callSid, turnNumber, role, content, confidence, latencyMs) {
  if (!supabase) return;
  try {
    await supabase.from("conversation_turns").insert({
      call_sid: callSid,
      turn_number: turnNumber,
      role,
      content,
      confidence: confidence || null,
      latency_ms: latencyMs || null,
    });
  } catch (e) {
    log(`⚠️ DB log turn error: ${e.message}`);
  }
}

async function dbEndCall(callSid, totalTurns, durationSec, status) {
  if (!supabase) return;
  try {
    await supabase.from("calls").update({
      ended_at: new Date().toISOString(),
      total_turns: totalTurns,
      duration_sec: durationSec,
      status: status || "completed",
    }).eq("call_sid", callSid);
  } catch (e) {
    log(`⚠️ DB end call error: ${e.message}`);
  }
}

async function dbLogOutcome(callSid, score) {
  if (!supabase) return;
  try {
    await supabase.from("calls").update({
      outcome_score: score,
    }).eq("call_sid", callSid);
  } catch (e) {
    log(`⚠️ DB outcome error: ${e.message}`);
  }
}

async function dbUpdateDailyStats() {
  if (!supabase) return;
  try {
    const today = new Date().toISOString().split("T")[0];
    const { data: calls } = await supabase
      .from("calls")
      .select("mode, total_turns, duration_sec, outcome_score")
      .gte("started_at", today + "T00:00:00Z");

    if (!calls || calls.length === 0) return;

    const stats = {
      date: today,
      total_calls: calls.length,
      dental_calls: calls.filter((c) => c.mode === "dental").length,
      agri_calls: calls.filter((c) => c.mode === "agri").length,
      avg_turns: calls.reduce((s, c) => s + (c.total_turns || 0), 0) / calls.length,
      avg_duration: calls.reduce((s, c) => s + (c.duration_sec || 0), 0) / calls.length,
      positive_outcomes: calls.filter((c) => c.outcome_score === 1).length,
      negative_outcomes: calls.filter((c) => c.outcome_score === 2).length,
      no_response_outcomes: calls.filter((c) => c.outcome_score === 3).length,
    };

    await supabase.from("daily_stats").upsert(stats, { onConflict: "date" });
  } catch (e) {
    log(`⚠️ DB daily stats error: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTE: Incoming call — Main menu
// ═══════════════════════════════════════════════════════════════

app.post("/voice", (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const from = req.body.From;

  log(`📞 Incoming call: ${callSid} from ${from}`);

  const conv = getConv(callSid);
  conv.startedAt = Date.now();

  // Log to DB
  dbLogCall(callSid, from, "unknown");

  const gather = twiml.gather({
    numDigits: 1,
    action: "/menu-select",
    method: "POST",
    timeout: 5,
    language: "ro-RO",
  });

  gather.say(
    VOICE,
    "Bună! Sunt OneVoice, asistentul tău vocal. " +
      "Apasă 1 pentru asistență dentară. " +
      "Apasă 2 pentru sfaturi agricole. " +
      "Sau rămâi pe linie și vorbește-mi direct."
  );

  twiml.redirect("/voice-input?mode=dental");
  res.type("text/xml").send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: Menu selection
// ═══════════════════════════════════════════════════════════════

app.post("/menu-select", (req, res) => {
  const twiml = new VoiceResponse();
  const digit = req.body.Digits;
  const callSid = req.body.CallSid;
  const conv = getConv(callSid);

  let mode, greeting;

  if (digit === "1") {
    mode = "dental";
    greeting = "Bine ai venit la asistența dentară MedicalCor. Cum te pot ajuta?";
  } else if (digit === "2") {
    mode = "agri";
    greeting = "Bine ai venit la asistența agricolă. Cu ce te pot ajuta?";
  } else {
    twiml.say(VOICE, "Nu am înțeles. Hai să încercăm din nou.");
    twiml.redirect("/voice");
    return res.type("text/xml").send(twiml.toString());
  }

  conv.mode = mode;
  log(`🎯 [${callSid}] Mode: ${mode}`);

  // Update DB with mode
  dbLogCall(callSid, req.body.From, mode);

  const gather = twiml.gather({
    input: "speech",
    action: `/process-speech?mode=${mode}`,
    method: "POST",
    speechTimeout: "auto",
    language: "ro-RO",
    timeout: 8,
  });

  gather.say(VOICE, greeting);
  twiml.say(VOICE, "Nu am auzit nimic. Poți să repeți?");
  twiml.redirect(`/voice-input?mode=${mode}`);
  res.type("text/xml").send(twiml.toString());
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

  gather.say(VOICE, "Te ascult.");
  twiml.say(VOICE, "Se pare că avem probleme. Încearcă să suni din nou. La revedere!");
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
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

  log(`🗣️ [${callSid}] "${speechResult}" (${(confidence * 100).toFixed(0)}%)`);

  // No speech
  if (!speechResult) {
    twiml.say(VOICE, "Nu am înțeles. Poți să repeți te rog?");
    twiml.redirect(`/voice-input?mode=${mode}`);
    return res.type("text/xml").send(twiml.toString());
  }

  const conv = getConv(callSid);
  conv.mode = mode;
  conv.turns++;

  // Log user turn to DB
  dbLogTurn(callSid, conv.turns, "user", speechResult, confidence, null);

  // Check for goodbye → ask for outcome
  const bye = /\b(pa|la revedere|gata|mulțumesc|bye|stop|terminat)\b/i;
  if (bye.test(speechResult)) {
    // Ask for outcome rating before hanging up
    const gather = twiml.gather({
      numDigits: 1,
      action: "/outcome",
      method: "POST",
      timeout: 5,
    });
    gather.say(
      VOICE,
      "Mulțumesc! Înainte să închid, ți-a fost utilă conversația noastră? " +
        "Apasă 1 pentru da. Apasă 2 pentru nu."
    );
    // If no response, end anyway
    twiml.say(VOICE, "Mulțumesc că ai sunat! Sănătate! La revedere!");
    twiml.hangup();

    dbEndCall(callSid, conv.turns, Math.round((Date.now() - conv.startedAt) / 1000), "completed");
    dbLogOutcome(callSid, 3); // no response default
    return res.type("text/xml").send(twiml.toString());
  }

  // Get AI response
  conv.messages.push({ role: "user", content: speechResult });
  const recentMessages = conv.messages.slice(-10);

  try {
    const t0 = Date.now();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: PROMPTS[mode] }, ...recentMessages],
      max_tokens: 150,
      temperature: 0.7,
    });

    const reply = completion.choices[0].message.content;
    const latency = Date.now() - t0;

    conv.messages.push({ role: "assistant", content: reply });
    log(`🤖 [${callSid}] (${latency}ms) "${reply}"`);

    // Log assistant turn to DB
    dbLogTurn(callSid, conv.turns, "assistant", reply, null, latency);

    // Speak reply + listen for more
    const gather = twiml.gather({
      input: "speech",
      action: `/process-speech?mode=${mode}`,
      method: "POST",
      speechTimeout: "auto",
      language: "ro-RO",
      timeout: 10,
    });

    gather.say(VOICE, reply);
    twiml.say(VOICE, "Dacă mai ai întrebări, sună oricând. La revedere!");
    twiml.hangup();
  } catch (err) {
    log(`❌ [${callSid}] OpenAI error: ${err.message}`);
    twiml.say(VOICE, "Am o problemă tehnică. Te rog sună din nou. Scuze!");
    twiml.hangup();
  }

  res.type("text/xml").send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: Outcome tracking
// ═══════════════════════════════════════════════════════════════

app.post("/outcome", (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const digit = req.body.Digits;

  const score = digit === "1" ? 1 : digit === "2" ? 2 : 3;
  const labels = { 1: "👍 UTIL", 2: "👎 NU A FOST UTIL", 3: "🤷 FĂRĂ RĂSPUNS" };

  log(`📊 [${callSid}] Outcome: ${labels[score]}`);
  dbLogOutcome(callSid, score);
  dbUpdateDailyStats();

  if (score === 1) {
    twiml.say(VOICE, "Mă bucur! Sună oricând ai nevoie. Sănătate! La revedere!");
  } else if (score === 2) {
    twiml.say(VOICE, "Îmi pare rău. Vom încerca să ne îmbunătățim. Mulțumesc pentru feedback! La revedere!");
  } else {
    twiml.say(VOICE, "Mulțumesc că ai sunat! La revedere!");
  }

  twiml.hangup();
  conversations.delete(callSid);
  res.type("text/xml").send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: Call status callback
// ═══════════════════════════════════════════════════════════════

app.post("/call-status", (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  log(`📊 Call ${CallSid}: ${CallStatus} (${CallDuration || "?"}s)`);

  if (CallStatus === "completed" || CallStatus === "failed") {
    const conv = conversations.get(CallSid);
    dbEndCall(CallSid, conv?.turns || 0, parseInt(CallDuration) || 0, CallStatus);
    dbUpdateDailyStats();
    conversations.delete(CallSid);
  }

  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: Live Dashboard (JSON)
// ═══════════════════════════════════════════════════════════════

app.get("/dashboard", async (req, res) => {
  if (!supabase) {
    return res.json({ error: "No database configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY." });
  }

  try {
    const today = new Date().toISOString().split("T")[0];

    // Today's calls
    const { data: todayCalls } = await supabase
      .from("calls")
      .select("*")
      .gte("started_at", today + "T00:00:00Z")
      .order("started_at", { ascending: false });

    // Recent conversations with turns
    const { data: recentCalls } = await supabase
      .from("calls")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(20);

    // Stats
    const { data: stats } = await supabase
      .from("daily_stats")
      .select("*")
      .order("date", { ascending: false })
      .limit(7);

    // Total outcomes
    const { data: allCalls } = await supabase
      .from("calls")
      .select("outcome_score")
      .not("outcome_score", "is", null);

    const outcomes = {
      total: allCalls?.length || 0,
      positive: allCalls?.filter((c) => c.outcome_score === 1).length || 0,
      negative: allCalls?.filter((c) => c.outcome_score === 2).length || 0,
      noResponse: allCalls?.filter((c) => c.outcome_score === 3).length || 0,
    };
    outcomes.satisfactionRate =
      outcomes.total > 0
        ? ((outcomes.positive / (outcomes.positive + outcomes.negative || 1)) * 100).toFixed(1) + "%"
        : "N/A";

    res.json({
      name: "OneVoice IVR Dashboard",
      phone: "+1 (517) 903-2276",
      timestamp: new Date().toISOString(),
      today: {
        calls: todayCalls?.length || 0,
        dental: todayCalls?.filter((c) => c.mode === "dental").length || 0,
        agri: todayCalls?.filter((c) => c.mode === "agri").length || 0,
      },
      outcomes,
      recentCalls: recentCalls?.map((c) => ({
        time: c.started_at,
        mode: c.mode,
        turns: c.total_turns,
        duration: c.duration_sec ? c.duration_sec + "s" : "?",
        outcome: c.outcome_score === 1 ? "👍" : c.outcome_score === 2 ? "👎" : "—",
        from: c.from_number?.replace(/(\d{3})\d{4}(\d{3})/, "$1****$2") || "hidden",
      })),
      weeklyStats: stats,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: View conversation details
// ═══════════════════════════════════════════════════════════════

app.get("/conversation/:callSid", async (req, res) => {
  if (!supabase) return res.json({ error: "No database" });

  try {
    const { data: call } = await supabase
      .from("calls")
      .select("*")
      .eq("call_sid", req.params.callSid)
      .single();

    const { data: turns } = await supabase
      .from("conversation_turns")
      .select("*")
      .eq("call_sid", req.params.callSid)
      .order("turn_number", { ascending: true });

    res.json({ call, turns });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE: Health check
// ═══════════════════════════════════════════════════════════════

app.get("/", (req, res) => {
  res.json({
    name: "OneVoice IVR",
    status: "🟢 LIVE",
    version: "2.0.0",
    phone: "+1 (517) 903-2276",
    modes: ["dental", "agri"],
    features: ["AI voice", "conversation logging", "outcome tracking", "dashboard"],
    activeCalls: conversations.size,
    database: supabase ? "🟢 connected" : "🔴 not configured",
    uptime: Math.floor(process.uptime()) + "s",
    endpoints: {
      call: "POST /voice",
      dashboard: "GET /dashboard",
      conversation: "GET /conversation/:callSid",
      health: "GET /health",
    },
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", db: !!supabase, timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`
╔══════════════════════════════════════════════════╗
║          🎙️  OneVoice IVR v2.0 — LIVE            ║
║                                                  ║
║  Port:      ${PORT}                                ║
║  Phone:     +1 (517) 903-2276                    ║
║  Modes:     Dental 🦷  |  Agri 🌾                ║
║  AI:        GPT-4o-mini                          ║
║  Database:  ${supabase ? "Supabase 🟢" : "None (logs only) 🟡"}             ║
║  Tracking:  Conversations + Outcomes             ║
║                                                  ║
║  GET /dashboard    ← Live stats                  ║
║  GET /             ← Health check                ║
║                                                  ║
╚══════════════════════════════════════════════════╝
  `);
});
