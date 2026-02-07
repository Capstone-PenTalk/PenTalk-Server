const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const teacher = await prisma.user.create({
    data: { name: "Demo Teacher", role: "teacher" },
  });

  const cls = await prisma.class.create({
    data: { title: "Demo Class", teacherId: teacher.id },
  });

  const mat = await prisma.material.create({
    data: { type: "pdf", url: "s3://demo/material.pdf", classId: cls.id },
  });

  const result = await prisma.class.findUnique({
    where: { id: cls.id },
    include: { teacher: true, materials: true },
  });

  console.log("✅ INSERT OK");
  console.log(JSON.stringify({ teacher, cls, mat, result }, null, 2));
}

main()
  .catch((e) => {
    console.error("❌ INSERT FAIL", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
