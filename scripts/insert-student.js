import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const student = await prisma.user.create({
    data: { name: "student1", role: "student" },
  });
  console.log("created student:", student);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
