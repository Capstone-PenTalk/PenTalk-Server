// prisma/seed.js
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seed start');

  // 교사
  const teacher = await prisma.user.upsert({
    where: { id: 'seed-teacher-01' },
    update: {},
    create: {
      id: 'seed-teacher-01',
      name: '테스트 교사',
      role: 'teacher',
    },
  });

  // 학생
  const student = await prisma.user.upsert({
    where: { id: 'seed-student-01' },
    update: {},
    create: {
      id: 'seed-student-01',
      name: '테스트 학생',
      role: 'student',
    },
  });

  // 클래스
  const cls = await prisma.class.upsert({
    where: { id: 'seed-class-01' },
    update: {},
    create: {
      id: 'seed-class-01',
      title: '테스트 클래스',
      teacherId: teacher.id,
    },
  });

  // 클래스 멤버 (교사 + 학생)
  await prisma.classMember.upsert({
    where: { classId_userId: { classId: cls.id, userId: teacher.id } },
    update: {},
    create: { classId: cls.id, userId: teacher.id, roleInClass: 'teacher' },
  });

  await prisma.classMember.upsert({
    where: { classId_userId: { classId: cls.id, userId: student.id } },
    update: {},
    create: { classId: cls.id, userId: student.id, roleInClass: 'student' },
  });

  // 자료 (materialId 테스트용)
  const material = await prisma.material.upsert({
    where: { id: 'seed-material-01' },
    update: {},
    create: {
      id: 'seed-material-01',
      type: 'pdf',
      url: 'https://example.com/sample.pdf',
      classId: cls.id,
    },
  });

  console.log('✅ Seed finished');
  console.log('─────────────────────────────────');
  console.log(`classId:    ${cls.id}`);
  console.log(`materialId: ${material.id}`);
  console.log(`teacherId:  ${teacher.id}`);
  console.log(`studentId:  ${student.id}`);
  console.log('─────────────────────────────────');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
