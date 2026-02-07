import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // 1) teacher
  const teacher = await prisma.user.create({
    data: { name: "teacher1_seed", role: "teacher" },
  });

  // 2) class
  const classA = await prisma.class.create({
    data: { title: "Class A", teacherId: teacher.id },
  });

  // 3) student
  const student = await prisma.user.create({
    data: { name: "student1_seed", role: "student" },
  });

  // 4) enrollment (ClassMember)
  await prisma.classMember.create({
    data: { userId: student.id, classId: classA.id },
  });

  // 5) material
  const material = await prisma.material.create({
    data: {
      type: "pdf",
      url: "https://example.com/test.pdf",
      classId: classA.id,
    },
  });

  // 6) tag
  const tag = await prisma.tag.create({
    data: { name: "math_seed" },
  });

  // 7) material-tag link
  await prisma.materialTag.create({
    data: { materialId: material.id, tagId: tag.id },
  });

  console.log("✅ Day8 seed done");
  console.log({ teacherId: teacher.id, classId: classA.id, studentId: student.id, materialId: material.id, tagId: tag.id });
}

main()
  .catch((e) => {
    console.error("❌ error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
