const fs = require('fs');
const http = require('http');
const path = require('path');

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJzZWVkLXRlYWNoZXItMDEiLCJyb2xlIjoidGVhY2hlciIsImlhdCI6MTc3NjI2OTE0MywiZXhwIjoxNzc2ODczOTQzfQ.dR_9f78c1Q57p1gIHpDeXQLHdV0b6fQl5uUbMbPvb9A';
const BOUNDARY = '----FormBoundary' + Date.now();
const FILE_PATH = '/tmp/test.pdf';

const fileData = fs.readFileSync(FILE_PATH);

const body = Buffer.concat([
  Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="classId"\r\n\r\nseed-class-01\r\n`),
  Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="test.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
  fileData,
  Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
]);

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/materials/pdf',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
    'Content-Length': body.length,
  },
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log(JSON.stringify(JSON.parse(data), null, 2));
  });
});

req.on('error', e => console.error(e));
req.write(body);
req.end();
