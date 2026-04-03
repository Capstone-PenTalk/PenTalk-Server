/**
 * #54 + #55 question 기능 테스트
 *
 * 시나리오:
 *   1. 학생 질문 전송 (익명 X) → QUESTION_ACK 수신 확인
 *   2. 교사가 QUESTION_NEW 실시간 수신 확인 (askedBy.userId 존재)
 *   3. 학생 익명 질문 전송 → ACK isAnonymous=true 확인
 *   4. 교사가 익명 QUESTION_NEW 수신 → askedBy.userId=null 확인
 *   5. 빈 문자열 전송 → QUESTION_EMPTY 에러 확인
 *   6. 길이 초과 전송 → QUESTION_TOO_LONG 에러 확인
 *   7. 교사가 QUESTION_LIST 요청 → 저장된 질문 목록 확인 (마스킹 포함)
 *   8. 학생이 QUESTION_LIST 요청 → FORBIDDEN 에러 확인
 */

require("dotenv").config();
const { io: ioClient } = require("socket.io-client");
const { signToken } = require("../src/utils/jwt");

const BASE = "http://localhost:3000";

const teacherToken = signToken({ userId: "teacher-question-test", role: "teacher" });
const studentToken = signToken({ userId: "student-question-test", role: "student" });

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

async function joinRoom(socket, sessionId, label) {
  await new Promise((resolve, reject) => {
    socket.once("connect", () => socket.emit("join_room", { roomId: sessionId }));
    socket.once("join_success", resolve);
    socket.once("server_error", (e) => reject(new Error(`[${label}] server_error: ${JSON.stringify(e)}`)));
    socket.connect();
  });
}

async function run() {
  console.log("[TEST] question 기능 테스트 시작\n");

  const sessionId = await createSession();
  console.log(`[SETUP] 세션 생성: ${sessionId}\n`);

  const teacher = connectSocket(teacherToken);
  const student  = connectSocket(studentToken);

  await joinRoom(teacher, sessionId, "TEACHER");
  console.log("[SETUP] 교사 join 완료");
  await joinRoom(student, sessionId, "STUDENT");
  console.log("[SETUP] 학생 join 완료\n");

  // --- 시나리오 1 & 2: 일반 질문 ---
  console.log("--- 시나리오 1 & 2: 일반 질문 → ACK / 교사 NEW ---");
  const ackPromise = waitForEvent(student, "question:ack");
  const newPromise = waitForEvent(teacher, "question:new");

  student.emit("question:ask", { content: "판서 내용이 잘 안 보여요", isAnonymous: false });

  const ack = await ackPromise;
  console.log("[STUDENT] question:ack 수신:", JSON.stringify(ack));
  console.assert(ack.questionId,                              "questionId 없음");
  console.assert(ack.content === "판서 내용이 잘 안 보여요",    "content 불일치");
  console.assert(ack.status === "PENDING",                    "status가 PENDING이어야 함");
  console.assert(ack.isAnonymous === false,                   "isAnonymous가 false여야 함");
  console.log("[OK] question:ack 검증 통과");

  const questionNew = await newPromise;
  console.log("[TEACHER] question:new 수신:", JSON.stringify(questionNew));
  console.assert(questionNew.questionId === ack.questionId,                      "questionId 불일치");
  console.assert(questionNew.askedBy.userId === "student-question-test",          "askedBy.userId 불일치");
  console.assert(questionNew.askedBy.isAnonymous === false,                       "askedBy.isAnonymous가 false여야 함");
  console.log("[OK] question:new 검증 통과\n");

  // --- 시나리오 3 & 4: 익명 질문 ---
  console.log("--- 시나리오 3 & 4: 익명 질문 → ACK isAnonymous=true / 교사 NEW userId=null ---");
  const anonAckPromise = waitForEvent(student, "question:ack");
  const anonNewPromise = waitForEvent(teacher, "question:new");

  student.emit("question:ask", { content: "이 부분 다시 설명해 주세요", isAnonymous: true });

  const anonAck = await anonAckPromise;
  console.log("[STUDENT] question:ack 수신:", JSON.stringify(anonAck));
  console.assert(anonAck.isAnonymous === true, "isAnonymous가 true여야 함");
  console.log("[OK] 익명 ACK 검증 통과");

  const anonNew = await anonNewPromise;
  console.log("[TEACHER] question:new 수신:", JSON.stringify(anonNew));
  console.assert(anonNew.askedBy.userId === null,        "익명 질문 askedBy.userId가 null이어야 함");
  console.assert(anonNew.askedBy.isAnonymous === true,   "askedBy.isAnonymous가 true여야 함");
  console.log("[OK] 익명 question:new 검증 통과\n");

  // --- 시나리오 5: 빈 문자열 ---
  console.log("--- 시나리오 5: 빈 문자열 → QUESTION_EMPTY ---");
  const emptyErrPromise = waitForEvent(student, "server_error");
  student.emit("question:ask", { content: "   " });
  const emptyErr = await emptyErrPromise;
  console.log("[STUDENT] server_error 수신:", JSON.stringify(emptyErr));
  console.assert(emptyErr.code === "QUESTION_EMPTY", `QUESTION_EMPTY여야 함, 실제: ${emptyErr.code}`);
  console.log("[OK] 빈 문자열 에러 검증 통과\n");

  // --- 시나리오 6: 길이 초과 ---
  console.log("--- 시나리오 6: 길이 초과 → QUESTION_TOO_LONG ---");
  const longErrPromise = waitForEvent(student, "server_error");
  student.emit("question:ask", { content: "A".repeat(501) });
  const longErr = await longErrPromise;
  console.log("[STUDENT] server_error 수신:", JSON.stringify(longErr));
  console.assert(longErr.code === "QUESTION_TOO_LONG", `QUESTION_TOO_LONG이어야 함, 실제: ${longErr.code}`);
  console.log("[OK] 길이 초과 에러 검증 통과\n");

  // --- 시나리오 7: 교사 question:list ---
  console.log("--- 시나리오 7: 교사 question:list 조회 ---");
  const listPromise = waitForEvent(teacher, "question:list:result");
  teacher.emit("question:list");
  const listResult = await listPromise;
  console.log("[TEACHER] question:list:result 수신:", JSON.stringify(listResult));
  console.assert(Array.isArray(listResult.questions),        "questions가 배열이어야 함");
  console.assert(listResult.questions.length >= 2,           "질문이 2개 이상이어야 함");
  const anonQ = listResult.questions.find(q => q.askedBy.isAnonymous === true);
  const normalQ = listResult.questions.find(q => q.askedBy.isAnonymous === false);
  console.assert(anonQ && anonQ.askedBy.userId === null,             "익명 질문 userId가 null이어야 함");
  console.assert(normalQ && normalQ.askedBy.userId === "student-question-test", "일반 질문 userId 불일치");
  console.log("[OK] question:list 검증 통과\n");

  // --- 시나리오 8: 학생이 question:list 요청 → FORBIDDEN ---
  console.log("--- 시나리오 8: 학생 question:list → FORBIDDEN ---");
  const forbiddenPromise = waitForEvent(student, "server_error");
  student.emit("question:list");
  const forbidden = await forbiddenPromise;
  console.log("[STUDENT] server_error 수신:", JSON.stringify(forbidden));
  console.assert(forbidden.code === "FORBIDDEN", `FORBIDDEN이어야 함, 실제: ${forbidden.code}`);
  console.log("[OK] 학생 접근 차단 검증 통과\n");

  teacher.disconnect();
  student.disconnect();

  console.log("=== [RESULT] 모든 시나리오 통과 ✅ ===");
}

run().catch((err) => {
  console.error("\n[RESULT] 테스트 실패:", err.message);
  process.exit(1);
});
