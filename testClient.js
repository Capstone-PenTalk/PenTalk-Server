require("dotenv").config();
const { io } = require("socket.io-client");

const sessionId = process.argv[2] || "31fa1c35-90b7-4d6c-9bb8-dda3e9d04544";
const classId = process.argv[3] || "cml3irfbx0002uvtjvazqiv3z";
const token = process.env.TEST_TOKEN;

console.log("TEST_TOKEN exists?", !!token, token?.slice(0, 20));
console.log("sessionId:", sessionId);

const socket = io("http://localhost:3000", {
  auth: { token },
});

let drawEventCount = 0;
const expectedEvents = ["ds", "dm", "dm", "dm", "de", "un", "er"];
const receivedEvents = [];
const ticks = [];

socket.on("connect", () => {
  console.log("[student] connected:", socket.id);
  socket.emit("join_room", { roomId: sessionId, classId });
});

socket.on("join_success", (data) => {
  console.log("[student] join_success:", data);
  console.log("[student] waiting for draw events...");
});

socket.on("draw_event", (payload) => {
  drawEventCount++;
  receivedEvents.push(payload.e);
  ticks.push(payload.t);
  console.log(`[student] draw_event #${drawEventCount} (${payload.e}) t=${payload.t}:`, JSON.stringify(payload));
});

socket.on("receive_dm", (payload) => {
  console.log("[student] receive_dm:", payload);
});

socket.on("server_error", (e) => {
  console.log("[student] server_error:", e);
});

socket.on("connect_error", (err) => {
  console.log("[student] connect_error:", err.message);
});

setTimeout(() => {
  console.log("\n--- Summary ---");
  console.log(`received ${drawEventCount} draw events`);
  console.log("event types:", receivedEvents.join(" -> "));
  console.log("expected:   ", expectedEvents.join(" -> "));
  const eventsMatch = JSON.stringify(receivedEvents) === JSON.stringify(expectedEvents);
  console.log("events match:", eventsMatch ? "OK" : "MISMATCH");

  const ticksOrdered = ticks.every((v, i) => i === 0 || v > ticks[i - 1]);
  console.log("ticks:", ticks.join(", "));
  console.log("ticks ordered:", ticksOrdered ? "OK" : "FAIL");

  const allPass = eventsMatch && ticksOrdered;
  console.log("result:", allPass ? "ALL PASS" : "FAIL");
  process.exit(allPass ? 0 : 1);
}, 10000);
