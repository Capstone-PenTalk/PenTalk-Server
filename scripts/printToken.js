require("dotenv").config();

const t = process.env.TEST_TOKEN;
if (!t) {
  console.log("no token");
  process.exit(0);
}

const payload = JSON.parse(Buffer.from(t.split(".")[1], "base64").toString());
console.log(payload);
