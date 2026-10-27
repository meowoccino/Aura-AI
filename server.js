
import http from "node:http";
import { Pool } from "pg";
import { timingSafeEqual, randomUUID } from "node:crypto";

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = "https://meowoccino.github.io";

for (const name of [
  "DATABASE_URL",
  "AURA_ACCESS_TOKEN",
  "OPENROUTER_API_KEY"
]) {
  if (!process.env[name]) {
    throw new Error(`${name} is missing from environment variables`);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

await pool.query(`
  CREATE TABLE IF NOT EXISTS aura_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const pathname =
    new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "") || "/";

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Vary", "Origin");

  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    return res.writeHead(204).end();
  }

  const send = (status, data) => {
    res.writeHead(status);
    res.end(JSON.stringify(data));
  };

  if (
    req.method === "GET" &&
    (pathname === "/" || pathname === "/health")
  ) {
    return send(200, { status: "ok", service: "AURA" });
  }

  if (origin !== ALLOWED_ORIGIN) {
    return send(403, { error: "Origin not allowed" });
  }

  const expected = Buffer.from(process.env.AURA_ACCESS_TOKEN);
  const suppliedHeader = req.headers.authorization || "";
  const supplied = Buffer.from(
    suppliedHeader.startsWith("Bearer ")
      ? suppliedHeader.slice(7)
      : ""
  );

  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return send(401, { error: "Access denied. Check your access token." });
  }

  if (
    req.method !== "POST" ||
    !["/chat", "/history"].includes(pathname)
  ) {
    return send(404, { error: "Not found" });
  }

  try {
    let raw = "";

    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 30000) {
        return send(413, { error: "Request too large" });
      }
    }

    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return send(400, { error: "Invalid JSON" });
    }

    const sessionId = String(body.sessionId || "");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
    ) {
      return send(400, { error: "Invalid session ID" });
    }

    if (pathname === "/history") {
      const result = await pool.query(
        `SELECT role, content FROM (
           SELECT id, role, content
           FROM aura_messages
           WHERE session_id = $1
           ORDER BY id DESC
           LIMIT 30
         ) recent
         ORDER BY id ASC`,
        [sessionId]
      );

      return send(200, { messages: result.rows });
    }

    const text = String(body.text || "").trim();

    if (!text || text.length > 6000) {
      return send(400, { error: "Message must be between 1 and 6000 characters" });
    }

    await pool.query(
      `INSERT INTO aura_messages (session_id, role, content)
       VALUES ($1, 'user', $2)`,
      [sessionId, text]
    );

    const result = await pool.query(
      `SELECT role, content FROM (
         SELECT id, role, content
         FROM aura_messages
         WHERE session_id = $1
         ORDER BY id DESC
         LIMIT 30
       ) recent
       ORDER BY id ASC`,
      [sessionId]
    );

    const upstream = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://meowoccino.github.io/Aura-AI/",
          "X-Title": "AURA"
        },
        body: JSON.stringify({
          model: "venice/uncensored",
          messages: [
            { role: "system", content: "Your name is AURA." },
            ...result.rows
          ],
          temperature: 0.8
        }),
        signal: AbortSignal.timeout(60000)
      }
    );

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error("OpenRouter error:", upstream.status, data?.error);
      return send(502, { error: "Model request failed. Check Render logs." });
    }

    const reply = String(data.choices?.[0]?.message?.content || "").trim();

    if (!reply) {
      return send(502, { error: "The model returned an empty reply." });
    }

    await pool.query(
      `INSERT INTO aura_messages (session_id, role, content)
       VALUES ($1, 'assistant', $2)`,
      [sessionId, reply]
    );

    return send(200, { reply });
  } catch (error) {
    console.error("AURA request failed:", error);
    return send(500, { error: "Request failed. Check Render logs." });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AURA backend listening on port ${PORT}`);
});
