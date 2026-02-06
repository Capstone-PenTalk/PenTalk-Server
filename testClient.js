const { io } = require("socket.io-client");

const sessionId = "33a1f7e7-4d8d-4d3b-be25-c6fe0636bc7c";
const token = process.env.TEST_TOKEN;

const socket = io("http://localhost:4001", {
  auth: { token },
});

socket.on("connect", () => {
  console.log("✅ connected:", socket.id);

  // ⚠️ 이벤트명이 다르면 여기 3개를 socket.events 값으로 바꿔야 함
  socket.emit("join-room", { roomId: sessionId });
});

socket.on("join-success", (data) => {
  console.log("✅ join-success:", data);
});

socket.on("receive-dm", (payload) => {
  console.log("📩 receive-dm:", payload);
});

socket.on("connect_error", (err) => {
  console.log("❌ connect_error:", err.message);
});

