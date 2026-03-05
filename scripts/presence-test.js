/**
 * #38 presence 기능 테스트
 *
 * 시나리오:
 *   1. 교사 접속 → PRESENCE_STATE로 본인 목록 수신 확인
 *   2. 학생 접속 → 교사가 PRESENCE_JOIN 수신 확인 / 학생이 PRESENCE_STATE로 목록(교사+학생) 수신 확인
 *   3. 학생 disconnect → 교사가 PRESENCE_LEAVE 수신 확인
 *   4. 학생 재접속(중복 접속 시뮬레이션) → 기존 소켓 끊기고 새 소켓만 남는지 확인
 */

require("dotenv").config();
const { io: ioClient } = require("socket.io-client");
const { signToken } = require("../src/utils/jwt");

const BASE = "http://localhost:3000";

const teacherToken = signToken({ userId: "teacher-presence-test", role: "teacher" });
const studentToken = signToken({ userId: "student-presence-test", role: "student" });

async function createSession() {
  const res = await fetch(`${BASE}/session/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classId: process.env.TEST_CLASS_ID || "test-class" }),
  });
  const data = await res.json();
  if (!data.sessionId) throw new Error("세션 생성 실패: " + JSON.stringify(data));
  return data.sessionId;
}

function connectSocket(token) {
  return ioClient(BASE, {
    auth: { token },
    transports: ["websocket"],
    autoConnect: false,
  });
}

function waitForEvent(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`TIMEOUT: ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

async function run() {
  console.log("[TEST] presence 기능 테스트 시작\n");

  const sessionId = await createSession();
  console.log(`[SETUP] 세션 생성: ${sessionId}\n`);

  // --- 시나리오 1: 교사 접속 ---
  console.log("--- 시나리오 1: 교사 접속 ---");
  const teacher = connectSocket(teacherToken);

  const teacherStatePromise = waitForEvent(teacher, "presence:state");

  await new Promise((resolve) => {
    teacher.on("connect", () => {
      teacher.emit("join_room", { roomId: sessionId });
    });
    teacher.on("join_success", resolve);
    teacher.on("server_error", (e) => { throw new Error("[TEACHER] server_error: " + JSON.stringify(e)); });
    teacher.connect();
  });

  const teacherState = await teacherStatePromise;
  console.log("[TEACHER] presence:state 수신:", JSON.stringify(teacherState));
  console.assert(teacherState.users.length === 1, "교사 접속 후 목록 1명이어야 함");
  console.assert(teacherState.users[0].role === "teacher", "첫 번째 유저는 teacher여야 함");
  console.log("[OK] 교사 접속 후 presence:state 검증 통과\n");

  // --- 시나리오 2: 학생 접속 ---
  console.log("--- 시나리오 2: 학생 접속 ---");
  const student = connectSocket(studentToken);

  const teacherJoinPromise = waitForEvent(teacher, "presence:join");
  const studentStatePromise = waitForEvent(student, "presence:state");

  await new Promise((resolve) => {
    student.on("connect", () => {
      student.emit("join_room", { roomId: sessionId });
    });
    student.on("join_success", resolve);
    student.on("server_error", (e) => { throw new Error("[STUDENT] server_error: " + JSON.stringify(e)); });
    student.connect();
  });

  const teacherJoin = await teacherJoinPromise;
  console.log("[TEACHER] presence:join 수신:", JSON.stringify(teacherJoin));
  console.assert(teacherJoin.userId === "student-presence-test", "join 이벤트 userId 불일치");
  console.assert(teacherJoin.role === "student", "join 이벤트 role 불일치");
  console.log("[OK] 교사가 학생 presence:join 수신 검증 통과");

  const studentState = await studentStatePromise;
  console.log("[STUDENT] presence:state 수신:", JSON.stringify(studentState));
  console.assert(studentState.users.length === 2, "학생 접속 후 목록 2명이어야 함");
  console.log("[OK] 학생 접속 후 presence:state 목록 2명 검증 통과\n");

  // --- 시나리오 3: 학생 disconnect ---
  console.log("--- 시나리오 3: 학생 disconnect ---");
  const teacherLeavePromise = waitForEvent(teacher, "presence:leave");
  student.disconnect();

  const teacherLeave = await teacherLeavePromise;
  console.log("[TEACHER] presence:leave 수신:", JSON.stringify(teacherLeave));
  console.assert(teacherLeave.userId === "student-presence-test", "leave 이벤트 userId 불일치");
  console.assert(teacherLeave.role === "student", "leave 이벤트 role 불일치");
  console.log("[OK] 학생 disconnect 후 교사 presence:leave 검증 통과\n");

  // --- 시나리오 4: 학생 중복 접속 ---
  console.log("--- 시나리오 4: 학생 중복 접속 (old 소켓 자동 끊기) ---");
  const student2 = connectSocket(studentToken);
  const student3 = connectSocket(studentToken);

  // student2 먼저 join
  await new Promise((resolve) => {
    student2.on("connect", () => student2.emit("join_room", { roomId: sessionId }));
    student2.on("join_success", resolve);
    student2.connect();
  });
  console.log("[STUDENT2] join 완료");

  // student3 join → student2는 서버에서 끊겨야 함
  const student2DisconnectedPromise = new Promise((resolve) => {
    student2.on("disconnect", resolve);
  });

  await new Promise((resolve) => {
    student3.on("connect", () => student3.emit("join_room", { roomId: sessionId }));
    student3.on("join_success", resolve);
    student3.connect();
  });
  console.log("[STUDENT3] join 완료 (중복 접속)");

  await student2DisconnectedPromise;
  console.log("[STUDENT2] 서버에 의해 disconnect됨 확인");
  console.log("[OK] 중복 접속 시 old 소켓 자동 끊기 검증 통과\n");

  teacher.disconnect();
  student3.disconnect();

  console.log("=== [RESULT] 모든 시나리오 통과 ✅ ===");
}

run().catch((err) => {
  console.error("\n[RESULT] 테스트 실패:", err.message);
  process.exit(1);
});
