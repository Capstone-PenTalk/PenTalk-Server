const { io } = require("socket.io-client");

const sessionId = "33a1f7e7-4d8d-4d3b-be25-c6fe0636bc7c";
const token = process.env.TEST_TOKEN;

const socket = io("http://localhost:4000", {
  auth: { token },
});

socket.on("connect", () => {
  console.log("✅ teacher connected:", socket.id);

  socket.emit("join-room", { roomId: sessionId });

  // join 후 1초 뒤 DM 전송
  setTimeout(() => {
    socket.emit("teacher-send-dm", { message: "hello from teacher client" });
    console.log("✉️ teacher-send-dm emitted");
  }, 1000);
});

socket.on("join-success", (data) => {
  console.log("✅ teacher join-success:", data);
});

socket.on("connect_error", (err) => {
  console.log("❌ connect_error:", err.message);
});

socket.on("error", (e) => {
  console.log("❌ error event:", e);
});
