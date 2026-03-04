require("dotenv").config();
const { io } = require("socket.io-client");
const { signToken } = require("./src/utils/jwt");

// 테스트용 토큰 생성
const validTeacherToken = signToken({ userId: "teacher_001", role: "teacher" });
const validStudentToken = signToken({ userId: "student_001", role: "student" });
const invalidRoleToken = signToken({ userId: "user_001", role: "invalid" });
const malformedToken = "malformed.token.here";

const sessionId = "test-session-id";
const classId = "test-class-id";

let testsPassed = 0;
let testsFailed = 0;

const { app, server } = require("./src/server");

// 서버 시작 후 테스트 실행
server.listen(3001, async () => {
  console.log("✅ Test server started on port 3001\n");

  // 테스트 1: Teacher 정상 접속
  console.log("📝 Test 1: Teacher normal connection with valid token");
  const testTeacher = io("http://localhost:3001", {
    auth: { token: validTeacherToken },
  });

  testTeacher.on("connect", () => {
    console.log("  ✅ Teacher connected successfully\n");
    testsPassed++;
    testTeacher.disconnect();
    setTimeout(() => runTest2(), 500);
  });

  testTeacher.on("connect_error", (err) => {
    console.log(`  ❌ Teacher connection failed: ${err.message}\n`);
    testsFailed++;
    setTimeout(() => runTest2(), 500);
  });

  function runTest2() {
    // 테스트 2: Student 정상 접속
    console.log("📝 Test 2: Student normal connection with valid token");
    const testStudent = io("http://localhost:3001", {
      auth: { token: validStudentToken },
    });

    testStudent.on("connect", () => {
      console.log("  ✅ Student connected successfully\n");
      testsPassed++;
      testStudent.disconnect();
      setTimeout(() => runTest3(), 500);
    });

    testStudent.on("connect_error", (err) => {
      console.log(`  ❌ Student connection failed: ${err.message}\n`);
      testsFailed++;
      setTimeout(() => runTest3(), 500);
    });
  }

  function runTest3() {
    // 테스트 3: Invalid role 토큰으로 접속 차단
    console.log("📝 Test 3: Invalid role token should be rejected");
    const testInvalidRole = io("http://localhost:3001", {
      auth: { token: invalidRoleToken },
    });

    testInvalidRole.on("connect", () => {
      console.log("  ❌ Invalid role token was NOT blocked (should have failed)\n");
      testsFailed++;
      testInvalidRole.disconnect();
      setTimeout(() => runTest4(), 500);
    });

    testInvalidRole.on("connect_error", (err) => {
      if (err.message.includes("UNAUTHORIZED")) {
        console.log("  ✅ Invalid role token correctly rejected\n");
        testsPassed++;
      } else {
        console.log(`  ❌ Wrong error: ${err.message}\n`);
        testsFailed++;
      }
      setTimeout(() => runTest4(), 500);
    });
  }

  function runTest4() {
    // 테스트 4: 토큰 없이 접속 차단
    console.log("📝 Test 4: No token should be rejected");
    const testNoToken = io("http://localhost:3001", {
      auth: {},
    });

    testNoToken.on("connect", () => {
      console.log("  ❌ No token was NOT blocked (should have failed)\n");
      testsFailed++;
      testNoToken.disconnect();
      setTimeout(() => runTest5(), 500);
    });

    testNoToken.on("connect_error", (err) => {
      if (err.message.includes("UNAUTHORIZED")) {
        console.log("  ✅ No token correctly rejected\n");
        testsPassed++;
      } else {
        console.log(`  ❌ Wrong error: ${err.message}\n`);
        testsFailed++;
      }
      setTimeout(() => runTest5(), 500);
    });
  }

  function runTest5() {
    // 테스트 5: 잘못된 토큰으로 접속 차단
    console.log("📝 Test 5: Malformed token should be rejected");
    const testMalformed = io("http://localhost:3001", {
      auth: { token: malformedToken },
    });

    testMalformed.on("connect", () => {
      console.log("  ❌ Malformed token was NOT blocked (should have failed)\n");
      testsFailed++;
      testMalformed.disconnect();
      setTimeout(() => finishTests(), 500);
    });

    testMalformed.on("connect_error", (err) => {
      if (err.message.includes("UNAUTHORIZED")) {
        console.log("  ✅ Malformed token correctly rejected\n");
        testsPassed++;
      } else {
        console.log(`  ❌ Wrong error: ${err.message}\n`);
        testsFailed++;
      }
      setTimeout(() => finishTests(), 500);
    });
  }

  function finishTests() {
    console.log("\n" + "=".repeat(50));
    console.log("📊 Test Results");
    console.log("=".repeat(50));
    console.log(`✅ Passed: ${testsPassed}`);
    console.log(`❌ Failed: ${testsFailed}`);
    console.log(`📈 Total: ${testsPassed + testsFailed}`);
    console.log("=".repeat(50) + "\n");

    const allPassed = testsFailed === 0;
    console.log(allPassed ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED");

    server.close(() => {
      process.exit(allPassed ? 0 : 1);
    });
  }
});
