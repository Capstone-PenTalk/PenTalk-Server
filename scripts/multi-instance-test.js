/**
 * #31 멀티 인스턴스 테스트
 *
 * 검증 목적:
 *   서버 인스턴스 A(4000)와 B(4001)가 각각 Redis pub/sub을 통해
 *   DM을 교환할 수 있는지 확인한다.
 *
 * 시나리오:
 *   1. 인스턴스 A에서 세션 생성
 *   2. 교사 → 인스턴스 A 소켓 연결 후 join
 *   3. 학생 → 인스턴스 B 소켓 연결 후 같은 세션 join
 *   4. 교사가 DM 전송 (인스턴스 A publish)
 *   5. 학생이 DM 수신 확인 (인스턴스 B subscriber → 브로드캐스트)
 */

require("dotenv").config();
const { io: ioClient } = require("socket.io-client");
const { signToken } = require("../src/utils/jwt");

const PORT_A = 4000;
const PORT_B = 4001;
const BASE_A = `http://localhost:${PORT_A}`;
const BASE_B = `http://localhost:${PORT_B}`;

const teacherToken = signToken({ userId: "teacher-multi-test", role: "teacher" });
const studentToken = signToken({ userId: "student-multi-test", role: "student" });

async function createSession() {
  const res = await fetch(`${BASE_A}/session/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classId: process.env.TEST_CLASS_ID || "test-class" }),
  });
  const data = await res.json();
  if (!data.sessionId) throw new Error("세션 생성 실패: " + JSON.stringify(data));
  return data.sessionId;
}

function connectSocket(baseUrl, token) {
  return ioClient(baseUrl, {
    auth: { token },
    transports: ["websocket"],
    autoConnect: false,  // 리스너 등록 후 수동 connect
  });
}

async function run() {
  console.log("[TEST] 멀티 인스턴스 DM 브로드캐스트 테스트 시작");
  console.log(`[TEST] 인스턴스 A: ${BASE_A}  /  인스턴스 B: ${BASE_B}`);

  // 1) 세션 생성 (인스턴스 A HTTP)
  const sessionId = await createSession();
  console.log(`[TEST] 세션 생성 완료: ${sessionId}`);

  // 2) 소켓 생성 (autoConnect: false → 리스너 먼저 등록)
  const teacherSocket = connectSocket(BASE_A, teacherToken);
  const studentSocket = connectSocket(BASE_B, studentToken);

  let passed = false;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("❌ TIMEOUT: 학생이 DM을 수신하지 못했습니다."));
    }, 6000);

    // 학생: DM 수신 대기
    studentSocket.on("receive_dm", (payload) => {
      clearTimeout(timeout);
      console.log(`[STUDENT] receive_dm 수신 ✅`);
      console.log(`  from: ${payload.from}  message: "${payload.message}"  ts: ${payload.ts}`);
      passed = true;
      resolve();
    });

    // 교사: join 후 DM 전송
    teacherSocket.on("join_success", () => {
      console.log(`[TEACHER] join_success (인스턴스 A)`);
      teacherSocket.emit("teacher_send_dm", { message: "multi-instance-test-dm" });
      console.log(`[TEACHER] DM 전송 → Redis publish`);
    });

    // 학생: join
    studentSocket.on("join_success", () => {
      console.log(`[STUDENT] join_success (인스턴스 B)`);
    });

    // 연결 완료 후 join
    teacherSocket.on("connect", () => {
      console.log(`[TEACHER] 소켓 연결 (인스턴스 A, id: ${teacherSocket.id})`);
      teacherSocket.emit("join_room", { roomId: sessionId });
    });

    studentSocket.on("connect", () => {
      console.log(`[STUDENT] 소켓 연결 (인스턴스 B, id: ${studentSocket.id})`);
      studentSocket.emit("join_room", { roomId: sessionId });
    });

    teacherSocket.on("server_error", (e) => {
      clearTimeout(timeout);
      reject(new Error(`[TEACHER] 서버 에러: ${JSON.stringify(e)}`));
    });

    studentSocket.on("server_error", (e) => {
      clearTimeout(timeout);
      reject(new Error(`[STUDENT] 서버 에러: ${JSON.stringify(e)}`));
    });

    // 리스너 등록 완료 후 연결 시작
    teacherSocket.connect();
    studentSocket.connect();
  });

  teacherSocket.disconnect();
  studentSocket.disconnect();

  if (passed) {
    console.log("\n[RESULT] ✅ 멀티 인스턴스 pub/sub 브로드캐스트 검증 완료");
    console.log("  - 인스턴스 A(교사) → Redis publish → 인스턴스 B(학생) 수신 확인");
  }
}

run().catch((err) => {
  console.error("\n[RESULT]", err.message);
  process.exit(1);
});
