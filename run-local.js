import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env file
try {
  const env = readFileSync(resolve(".env"), "utf8");
  for (const line of env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    process.env[key] = value;
  }
} catch {
  console.error("No .env file found. Copy .env.example to .env and fill in values.");
  process.exit(1);
}

const { default: main } = await import("./src/main.js");

const req = { method: "GET", path: "/" };
const res = {
  json: (data, status = 200) => {
    console.log(`\nResponse (${status}):`, JSON.stringify(data, null, 2));
    return data;
  },
};

console.log("Starting function...\n");
await main({ req, res, log: console.log, error: console.error });
