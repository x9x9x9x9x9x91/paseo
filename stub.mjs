// A stand-in Anthropic API: logs every request and refuses it, so nothing runs.
// node stub.mjs <port> <name> <logfile> <marker>
import fs from "node:fs";
import http from "node:http";

const [port, name, logFile, marker] = process.argv.slice(2);
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let model = null;
      try {
        model = JSON.parse(body).model ?? null;
      } catch {}
      const entry = {
        at: new Date().toISOString(),
        endpoint: name,
        request: `${req.method} ${req.url}`,
        model,
        firstMessageInBody: body.includes(marker),
      };
      fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: `${name}: refused by the QA stub` },
        }),
      );
    });
  })
  .listen(Number(port), "127.0.0.1");
