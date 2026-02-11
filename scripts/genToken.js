require("dotenv").config();
const { signToken } = require("../src/utils/jwt");

const token = signToken({
  userId: "teacher-test",
  role: "teacher",
});

console.log("\n=== TEST TOKEN ===\n");
console.log(token);
console.log("\n==================\n");
