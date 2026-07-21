FROM node:20-alpine

WORKDIR /app

# PDF 페이지 서버 래스터화(pdftoppm) - 교사/학생 판서 좌표 정렬을 위해 필요
RUN apk add --no-cache poppler-utils

COPY package*.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
