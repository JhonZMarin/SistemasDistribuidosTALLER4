const path = require("path");

require("dotenv").config();

const express = require("express");

function readRequiredEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.replace(/\/+$/, "");
}

function readOptionalEnv(name) {
  return String(process.env[name] || "").trim();
}

function readPort() {
  const rawPort = String(process.env.PORT || "").trim();

  if (!rawPort) {
    throw new Error("Missing required environment variable: PORT");
  }

  const parsedPort = Number.parseInt(rawPort, 10);

  if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  return parsedPort;
}

const runtimeConfig = Object.freeze({
  AUTH_URL: readRequiredEnv("AUTH_URL"),
  WS_URL: readOptionalEnv("WS_URL"),
  GOOGLE_CLIENT_ID: readOptionalEnv("GOOGLE_CLIENT_ID")
});

const port = readPort();
const app = express();

app.use((_request, response, next) => {
  response.set("Cache-Control", "no-store");
  next();
});

app.get("/js/runtime-config.js", (_request, response) => {
  response.type("application/javascript");
  response.send(`window.RUNTIME_CONFIG = Object.freeze(${JSON.stringify(runtimeConfig)});\n`);
});

app.use(express.static(__dirname));

app.get("/", (_request, response) => {
  response.sendFile(path.join(__dirname, "login.html"));
});

app.listen(port, () => {
  console.log(`Client web listening on http://localhost:${port}`);
});
