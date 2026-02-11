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

socket.on("connect", () => {
  console.log("[teacher] connected:", socket.id);
  socket.emit("join_room", { roomId: sessionId, classId });
});

socket.on("join_success", (data) => {
  console.log("[teacher] join_success:", data);

  const strokeId = Date.now();

  // ds: draw_start
  setTimeout(() => {
    socket.emit("draw_event", {
      e: "ds",
      sId: strokeId,
      x: 0.1,
      y: 0.2,
      c: "#FF0000",
      w: 2.5,
    });
    console.log("[teacher] ds emitted, sId:", strokeId);
  }, 300);

  // dm: draw_stream (3 points)
  const points = [
    { x: 0.15, y: 0.25 },
    { x: 0.2, y: 0.3 },
    { x: 0.25, y: 0.35 },
  ];
  points.forEach((pt, i) => {
    setTimeout(() => {
      socket.emit("draw_event", {
        e: "dm",
        sId: strokeId,
        x: pt.x,
        y: pt.y,
      });
      console.log(`[teacher] dm emitted (${i + 1}/${points.length})`);
    }, 400 + i * 100);
  });

  // de: draw_end
  setTimeout(() => {
    socket.emit("draw_event", {
      e: "de",
      sId: strokeId,
      pts: [
        { x: 0.1, y: 0.2 },
        { x: 0.15, y: 0.25 },
        { x: 0.2, y: 0.3 },
        { x: 0.25, y: 0.35 },
      ],
    });
    console.log("[teacher] de emitted");
  }, 800);

  // un: undo
  setTimeout(() => {
    socket.emit("draw_event", { e: "un", sId: strokeId });
    console.log("[teacher] un emitted, sId:", strokeId);
  }, 1000);

  // er: eraser
  const eraserStrokeId = Date.now() + 1;
  setTimeout(() => {
    socket.emit("draw_event", { e: "er", sId: eraserStrokeId });
    console.log("[teacher] er emitted, sId:", eraserStrokeId);
  }, 1200);

  // done
  setTimeout(() => {
    console.log("[teacher] all draw events sent. exiting.");
    process.exit(0);
  }, 1500);
});

socket.on("draw_event", (payload) => {
  console.log("[teacher] received draw_event:", payload);
});

socket.on("server_error", (e) => {
  console.log("[teacher] server_error:", e);
});

socket.on("connect_error", (err) => {
  console.log("[teacher] connect_error:", err.message);
});
