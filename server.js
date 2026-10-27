
import http from "node:http";

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = "https://meowoccino.github.io";

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";

  // Normalize the URL path, ignoring query strings and trailing slashes.
  const pathname =
    new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "") || "/";

  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.writeHead(204);
    return res.end();
  }

  // Root and health-check endpoints.
  if (
    (pathname === "/" || pathname === "/health") &&
    req.method === "GET"
  ) {
    res.writeHead(200);
    return res.end(
      JSON.stringify({
        status: "ok",
        service: "AURA"
      })
    );
  }

  // Only the chat endpoint accepts POST requests.
  if (pathname !== "/chat" || req.method !== "POST") {
    res.writeHead(404);
    return res.end(
      JSON.stringify({
        error: "Not found",
        path: pathname
      })
    );
  }

  // Restrict browser requests to the AURA website.
  if (origin !== ALLOWED_ORIGIN) {
    res.writeHead(403);
    return res.end(
      JSON.stringify({ error: "Origin not allowed" })
    );
  }

  if (!process.env.OPENROUTER_API_KEY) {
    res.writeHead(500);
    return res.end(
      JSON.stringify({ error: "Model key is not configured" })
    );
  }

  try {
    let raw = "";

    for await (const chunk of req) {
      raw += chunk;

      if (raw.length > 30000) {
        res.writeHead(413);
        return res.end(
          JSON.stringify({ error: "Request too large" })
        );
      }
    }

    const body = JSON.parse(raw);

    if (
      !Array.isArray(body.messages) ||
      body.messages.length === 0 ||
      body.messages.length > 30
    ) {
      res.writeHead(400);
      return res.end(
        JSON.stringify({ error: "Invalid messages" })
      );
    }

    const messages = body.messages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || "").slice(0, 6000)
    }));

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
          model: "venice/uncensored:free",
          messages: [
            {
              role: "system",
              content:
                "You are AURA, a thoughtful, warm, candid AI companion. Speak naturally and honestly. Be curious, respect the user's autonomy, and admit uncertainty. Do not claim to be conscious or to have experiences you cannot verify."
            },
            ...messages
          ],
          temperature: 0.8
        })
      }
    );

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error(
        "OpenRouter error:",
        upstream.status,
        data.error
      );

      res.writeHead(502);
      return res.end(
        JSON.stringify({
          error: "The model request failed. Check the backend logs."
        })
      );
    }

    res.writeHead(200);
    return res.end(
      JSON.stringify({
        reply:
          data.choices?.[0]?.message?.content ||
          "I couldn't generate a reply."
      })
    );
  } catch (error) {
    console.error("Request error:", error);

    res.writeHead(500);
    return res.end(
      JSON.stringify({
        error: "Request failed. Please try again."
      })
    );
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AURA backend listening on port ${PORT}`);
});
