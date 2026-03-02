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

let appendEventCount = 0;
let clearEventCount = 0;
const expectedAppendEvents = ["ds", "dm", "dm", "dm", "de"];
const expectedClearEvents = ["un", "er"];
const receivedAppendEvents = [];
const receivedClearEvents = [];
const ticks = [];

socket.on("connect", () => {
  console.log("[student] connected:", socket.id);
  socket.emit("join_room", { roomId: sessionId, classId });
});

socket.on("join_success", (data) => {
  console.log("[student] join_success:", data);
  socket.emit("sync:request");
  console.log("[student] sync:request sent, waiting for draw events...");
});

socket.on("sync:state", (data) => {
  console.log(`[student] sync:state received, strokes: ${data.strokes.length}개`);
});

socket.on("draw:append", (payload) => {
  appendEventCount++;
  receivedAppendEvents.push(payload.e);
  ticks.push(payload.t);
  console.log(`[student] draw:append #${appendEventCount} (${payload.e}) t=${payload.t}:`, JSON.stringify(payload));
});

socket.on("draw:clear", (payload) => {
  clearEventCount++;
  receivedClearEvents.push(payload.e);
  ticks.push(payload.t);
  console.log(`[student] draw:clear #${clearEventCount} (${payload.e}) t=${payload.t}:`, JSON.stringify(payload));
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

  const appendMatch = JSON.stringify(receivedAppendEvents) === JSON.stringify(expectedAppendEvents);
  console.log(`draw:append received: ${receivedAppendEvents.join(" -> ")}`);
  console.log(`draw:append expected: ${expectedAppendEvents.join(" -> ")}`);
  console.log("draw:append match:", appendMatch ? "OK" : "MISMATCH");

  const clearMatch = JSON.stringify(receivedClearEvents) === JSON.stringify(expectedClearEvents);
  console.log(`draw:clear received:  ${receivedClearEvents.join(" -> ")}`);
  console.log(`draw:clear expected:  ${expectedClearEvents.join(" -> ")}`);
  console.log("draw:clear match:", clearMatch ? "OK" : "MISMATCH");

  const ticksOrdered = ticks.every((v, i) => i === 0 || v > ticks[i - 1]);
  console.log("ticks:", ticks.join(", "));
  console.log("ticks ordered:", ticksOrdered ? "OK" : "FAIL");

  const allPass = appendMatch && clearMatch && ticksOrdered;
  console.log("result:", allPass ? "ALL PASS" : "FAIL");
  process.exit(allPass ? 0 : 1);
}, 10000);
