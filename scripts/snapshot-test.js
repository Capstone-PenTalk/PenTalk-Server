require("dotenv").config();
const { io: ioClient } = require("socket.io-client");
const { signToken } = require("../src/utils/jwt");

const BASE = "http://localhost:4000";
const teacherToken = signToken({ userId: "t1", role: "teacher" });
const studentToken = signToken({ userId: "s1", role: "student" });

function makeSocket(token) {
  return ioClient(BASE, { auth: { token }, transports: ["websocket"], autoConnect: false });
}

async function run() {
  // 1) 세션 생성
  const res = await fetch(`${BASE}/session/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classId: process.env.TEST_CLASS_ID }),
  });
  const { sessionId } = await res.json();
  console.log(`[TEST] 세션: ${sessionId}`);

  // 2) 교사가 획 완성 (ds → de)
  const teacher = makeSocket(teacherToken);
  await new Promise((resolve, reject) => {
    teacher.on("connect", () => teacher.emit("join_room", { roomId: sessionId }));
    teacher.on("join_success", () => {
      console.log("[TEACHER] join_success");
      teacher.emit("draw_event", { e: "ds", sId: 99991, x: 0.1, y: 0.2, c: "#FF0000", w: 3 });
      teacher.emit("draw_event", { e: "dm", sId: 99991, x: 0.15, y: 0.25 });
      teacher.emit("draw_event", {
        e: "de", sId: 99991,
        pts: [{ x: 0.1, y: 0.2 }, { x: 0.15, y: 0.25 }, { x: 0.2, y: 0.3 }],
      });
      console.log("[TEACHER] ds + dm + de 전송 완료");
      setTimeout(resolve, 400);
    });
    teacher.on("server_error", (e) => reject(new Error(JSON.stringify(e))));
    teacher.connect();
  });
  teacher.disconnect();

  // 3) 학생이 재접속 → draw_snapshot 수신 확인
  const student = makeSocket(studentToken);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("TIMEOUT")), 4000);
    student.on("connect", () => student.emit("join_room", { roomId: sessionId }));
    student.on("draw_snapshot", (data) => {
      clearTimeout(t);
      console.log(`[STUDENT] draw_snapshot 수신 ✅  strokes: ${data.strokes.length}개`);
      const s = data.strokes[0];
      console.log(`  sId:${s?.sId}  c:${s?.c}  w:${s?.w}  pts:${s?.pts?.length}개`);
      resolve();
    });
    student.on("server_error", (e) => { clearTimeout(t); reject(new Error(JSON.stringify(e))); });
    student.connect();
  });
  student.disconnect();

  console.log("\n[RESULT] ✅ Snapshot 저장 및 재접속 복원 검증 완료");
}

run().catch((e) => { console.error("\n[RESULT] ❌", e.message); process.exit(1); });
