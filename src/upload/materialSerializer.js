// src/upload/materialSerializer.js
// material + MaterialPage[] -> 클라이언트 응답 shape 변환. 업로드 응답/session join/JOIN_SUCCESS에서 공통 사용.

const { getPresignedUrl } = require('../lib/s3');

async function serializeMaterialWithPages(material, materialPages) {
  const pages = await Promise.all(
    (materialPages || [])
      .slice()
      .sort((a, b) => a.pageNumber - b.pageNumber)
      .map(async (p) => ({
        pageNumber: p.pageNumber,
        imageUrl: await getPresignedUrl(p.imageKey),
        width: p.width,
        height: p.height,
      }))
  );

  return {
    materialId: material.id,
    type: material.type,
    name: material.name ?? null,
    sizeInBytes: material.sizeInBytes ?? null,
    pages,
  };
}

module.exports = { serializeMaterialWithPages };
