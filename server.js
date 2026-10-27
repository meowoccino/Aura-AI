
import http from "node:http";

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = "https://meowoccino.github.io";

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const pathname =
    new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "") || "/";

  console.log(
    "Incoming request:",
    req.method,
    pathname,
    "origin:",
    origin || "(none)"
  );

  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.writeHead(204);
    return res.end();
  }

  if (
    (pathname === "/" || pathname === "/health") &&
    req.method === "GET"
  ) {
    res.writeHead(200);
    return res.end(JSON.stringify({
      status: "ok",
      service: "AURA"
    }));
  }

  if (pathname !== "/chat" || req.method !== "POST") {
    res.writeHead(404);
    return res.end(JSON.stringify({
      error: "Not found",
      path: pathname
    }));
  }

  if (origin !== ALLOWED_ORIGIN) {
    console.warn("Chat request rejected: origin not allowed");
    res.writeHead(403);
    return res.end(JSON.stringify({
      error: "Origin not allowed"
    }));
  }

  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY is missing in Render environment");
    res.writeHead(500);
    return res.end(JSON.stringify({
      error: "Model key is not configured"
    }));
  }

  try {
    let raw = "";

    for await (const chunk of req) {
      raw += chunk;

      if (raw.length > 30000) {
        res.writeHead(413);
        return res.end(JSON.stringify({
          error: "Request too large"
        }));
      }
    }

    let body;

    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      return res.end(JSON.stringify({
        error: "Invalid JSON request"
      }));
    }

    if (
      !Array.isArray(body.messages) ||
      body.messages.length === 0 ||
      body.messages.length > 30
    ) {
      res.writeHead(400);
      return res.end(JSON.stringify({
        error: "Invalid messages"
      }));
    }

    const messages = body.messages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || "").slice(0, 6000)
    }));

    console.log("Sending chat request to OpenRouter");

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
            {
              role: "system",
              content: "Your name is AURA."
            },
            ...messages
          ],
          temperature: 0.8
        }),
        signal: AbortSignal.timeout(60000)
      }
    );

    console.log("OpenRouter HTTP status:", upstream.status);

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error(
        "OpenRouter error:",
        upstream.status,
        data?.error?.message || data?.error?.code || "Unknown provider error"
      );

      res.writeHead(502);
      return res.end(JSON.stringify({
        error: "The model request failed. Check the backend logs."
      }));
    }

    const reply = data.choices?.[0]?.message?.content;

    if (!reply) {
      console.error("OpenRouter returned no message content");
      res.writeHead(502);
      return res.end(JSON.stringify({
        error: "The model returned an empty reply."
      }));
    }

    console.log("AURA reply generated successfully");

    res.writeHead(200);
    return res.end(JSON.stringify({ reply }));

  } catch (error) {
    console.error(
      "Chat request failed:",
      error?.name || "Error",
      error?.message || "Unknown error"
    );

    res.writeHead(500);
    return res.end(JSON.stringify({
      error: "Request failed. Please try again."
    }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AURA backend listening on port ${PORT}`);
});
