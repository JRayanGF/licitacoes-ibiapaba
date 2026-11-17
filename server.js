// Servidor simples: serve o site e a mesma função proxy usada no Netlify
const http = require("http"), fs = require("fs"), path = require("path"), url = require("url");
const { handler } = require("./netlify/functions/pncp.js");
http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  if (u.pathname === "/.netlify/functions/pncp" || u.pathname === "/api/pncp") {
    const r = await handler({ queryStringParameters: u.query });
    res.writeHead(r.statusCode, r.headers); return res.end(r.body);
  }
  fs.readFile(path.join(__dirname, "index.html"), (e, d) => {
    res.writeHead(e ? 500 : 200, { "content-type": "text/html; charset=utf-8" }); res.end(e ? "erro" : d);
  });
}).listen(process.env.PORT || 3000, "0.0.0.0");
