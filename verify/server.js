// Minimal HTTP server used by the verify fixture. Prints the bound URL so the
// guard's log-based URL discovery has something real to find, then keeps
// answering so health probes see a live server.
import * as http from "node:http";

const port = Number(process.env.PORT || 5199);
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}/`);
});
