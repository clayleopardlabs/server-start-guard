// Detection matrix: guards the two failure modes that matter.
//   - false negative -> a server start runs in the foreground and can hang
//   - false positive -> a read-only command's output is moved into a log file
// Run after `npm run build` (imports the compiled modules).
import { detect, isAlreadySafe } from "../dist/rewrite.js";

const cfg = {
  enabled: true,
  logDir: "",
  bashTimeoutMs: 600000,
  detachTimeoutMs: 15000,
  watchdogEnabled: true,
  watchdogPollMs: 10000,
  watchdogStalledAfterMs: 300000,
  extraPatterns: [],
  healthChecks: [],
  defaultHealthChecks: true,
  healthTimeoutMs: 2000,
  healthIntervalMs: 15000,
  healthGraceMs: 30000,
};

const yes = [
  "npm run dev",
  "npm start",
  "pnpm dev",
  "yarn serve",
  "bun run preview",
  "npm run dev:web",
  "cd app && npm run dev",
  "NODE_ENV=production npm start",
  "npx vite",
  "vite --host",
  "./node_modules/.bin/vite --host",
  "npx --yes serve -s dist",
  "nodemon server.js",
  "node server.js",
  "node --watch app.mjs",
  "python -m http.server 8000",
  "python3 app.py",
  "uvicorn main:app --reload",
  "flask --app app run",
  "manage.py runserver",
  "go run ./cmd/server.go",
  "dotnet watch",
  "dotnet run",
  "java -jar build/libs/app.jar",
  "cargo run",
  "rails s",
  "php -S localhost:8000",
  "docker compose up -d",
  "docker-compose up",
  "ngrok http 3000",
  "ng serve",
  "next dev",
  "astro dev",
  "webpack serve",
  "./dev.sh",
  "nohup ./worker > /tmp/w.log 2>&1 &",
  "nohup x > log 2>&1 &\nnpm run dev",
  "make build && npm run dev",
  "sudo npm run dev",
  // Regressions found in review: wrappers that used to be caught unanchored.
  "python manage.py runserver",
  "python3 manage.py runserver 0.0.0.0:8000",
  "./manage.py runserver",
  "env/bin/python manage.py runserver",
  "bash -lc 'npm run dev'",
  "cmd /c npm run dev",
  "wsl -d Ubuntu -- npm run dev",
  "wsl -d Ubuntu -- bash -lc 'npm run dev'",
  "pnpm exec vite",
  "cross-env NODE_ENV=development npm start",
  "npm --prefix web run dev",
  "sudo -u www-data npm start",
  "timeout 30 npm run dev",
  // wsl invocation forms that used to be caught by the unanchored patterns.
  "wsl -d Ubuntu -e npm run dev",
  "wsl Ubuntu npm run dev",
];

const no = [
  "npm run build",
  "npm test",
  "npm ls vite",
  "npm i -g nodemon",
  "cat vite.config.ts",
  "rg Start-Process src",
  "rg -n 'Win32_Process' src",
  "git log --grep vite",
  "git log --oneline -5",
  "node -e 'console.log(1)'",
  "node verify/detect.mjs",
  "docker compose ps",
  "docker run --rm alpine echo hi",
  "echo 'npm run dev'",
  "ls -la",
  "npm test &&\n  echo done",
  "python script.py",
  "flask routes",
  "make dev-docs",
  "cargo test",
  // A flag that takes a value must not push the command position past the
  // real program: these are formatters, not dev servers.
  "npx -y prettier vite.config.ts",
  "npx -y eslint vite.config.ts",
  "bash -lc 'cat vite.config.ts'",
  "wsl -d Ubuntu -- cat /etc/hosts",
];

// The POSIX branch of isAlreadySafe is unreachable on win32, so test it
// directly: a nohup that leaves either stream on the tool's pipe still hangs.
const posixSafe = [
  "nohup ./srv > out 2>&1 &",
  "nohup ./srv >out 2>err &",
  "nohup ./srv &> all.log &",
];
const posixUnsafe = [
  "nohup ./srv 2> err.txt &",
  "nohup ./srv > out.txt &",
  "nohup ./srv &",
  // `2>&1` BEFORE the stdout redirect leaves stderr on the tool's pipe.
  "nohup ./srv 2>&1 > out.log &",
];

let failures = 0;
for (const cmd of yes) {
  if (!detect(cmd, cfg)) {
    failures++;
    console.log(`FAIL (missed)   ${JSON.stringify(cmd)}`);
  }
}
for (const cmd of no) {
  if (detect(cmd, cfg)) {
    failures++;
    console.log(`FAIL (false +)  ${JSON.stringify(cmd)}`);
  }
}
for (const cmd of posixSafe) {
  if (!isAlreadySafe(cmd, false)) {
    failures++;
    console.log(`FAIL (posix safe)   ${JSON.stringify(cmd)}`);
  }
}
for (const cmd of posixUnsafe) {
  if (isAlreadySafe(cmd, false)) {
    failures++;
    console.log(`FAIL (posix unsafe) ${JSON.stringify(cmd)}`);
  }
}

const total = yes.length + no.length + posixSafe.length + posixUnsafe.length;
console.log(`detect: ${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
