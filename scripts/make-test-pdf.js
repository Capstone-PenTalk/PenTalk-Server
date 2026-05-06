const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

PDFDocument.create()
  .then(p => p.save())
  .then(b => {
    fs.writeFileSync('/tmp/test.pdf', b);
    console.log('done: /tmp/test.pdf');
  });
